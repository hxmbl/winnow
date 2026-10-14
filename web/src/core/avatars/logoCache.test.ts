import { describe, expect, it, vi } from "vitest";
import {
  BrandLogoCache,
  LOGO_HIT_TTL_MS,
  LOGO_MISS_TTL_MS,
  LOGO_RETRY_MS,
  memoryLogoStorage,
} from "./logoCache";
import type { TxtAnswer } from "./bimi";

const LOGO = "https://cdn.example/brand.svg";

function setup(options: { records?: Record<string, string[]>; fail?: boolean; concurrency?: number; perMinute?: number } = {}) {
  let now = 1_000_000;
  const pending: (() => void)[] = [];
  const resolve = vi.fn(async (name: string): Promise<TxtAnswer> => {
    if (options.fail) throw new Error("offline");
    const records = options.records ?? { "default._bimi.brand.example": [`v=BIMI1; l=${LOGO}`] };
    return records[name] ? { kind: "records", records: records[name] } : { kind: "none" };
  });
  const storage = memoryLogoStorage();
  const timers: { fn: () => void; ms: number }[] = [];
  const cache = new BrandLogoCache({
    resolve,
    storage,
    now: () => now,
    concurrency: options.concurrency,
    perMinute: options.perMinute,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  return {
    cache,
    resolve,
    storage,
    timers,
    pending,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("BrandLogoCache", () => {
  it("caches a hit and serves it synchronously afterwards", async () => {
    const { cache, resolve } = setup();
    expect(cache.peek("news@brand.example")).toEqual({ kind: "unknown" });
    expect(await cache.request("news@brand.example")).toBe(LOGO);
    expect(cache.peek("other@brand.example")).toEqual({ kind: "logo", url: LOGO });
    expect(await cache.request("other@brand.example")).toBe(LOGO);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("caches a miss for a day and a hit for a week", async () => {
    const { cache, resolve, advance } = setup();
    await cache.request("a@plain.example");
    await cache.request("a@brand.example");
    const calls = resolve.mock.calls.length;
    advance(LOGO_MISS_TTL_MS - 1);
    expect(cache.peek("a@plain.example")).toEqual({ kind: "none" });
    advance(2);
    expect(cache.peek("a@plain.example")).toEqual({ kind: "unknown" });
    expect(cache.peek("a@brand.example")).toEqual({ kind: "logo", url: LOGO });
    advance(LOGO_HIT_TTL_MS);
    expect(cache.peek("a@brand.example")).toEqual({ kind: "unknown" });
    expect(resolve.mock.calls.length).toBe(calls);
  });

  it("dedupes concurrent lookups for one domain", async () => {
    const { cache, resolve } = setup();
    const results = await Promise.all([
      cache.request("a@brand.example"),
      cache.request("b@brand.example"),
      cache.request("c@brand.example"),
    ]);
    expect(results).toEqual([LOGO, LOGO, LOGO]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup as a miss, and retries after a cool-down", async () => {
    const { cache, resolve, advance } = setup({ fail: true });
    expect(await cache.request("a@brand.example")).toBeNull();
    expect(cache.peek("a@brand.example")).toEqual({ kind: "unknown" });
    expect(await cache.request("a@brand.example")).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    advance(LOGO_RETRY_MS);
    await cache.request("a@brand.example");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("caps lookups per minute and resumes on the timer", async () => {
    const { cache, resolve, timers, advance } = setup({ perMinute: 2, concurrency: 5 });
    const a = cache.request("x@one.example");
    const b = cache.request("x@two.example");
    const c = cache.request("x@three.example");
    await Promise.all([a, b]);
    // Each domain with no record costs one query (two-label domains have no fallback).
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(timers.length).toBe(1);
    advance(60_000);
    timers[0].fn();
    await c;
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("persists across instances and clears completely", async () => {
    const { cache, storage } = setup();
    await cache.request("a@brand.example");
    const again = new BrandLogoCache({ resolve: async () => ({ kind: "none" }), storage, now: () => 1_000_000 });
    expect(again.peek("a@brand.example")).toEqual({ kind: "logo", url: LOGO });
    again.clear();
    expect(again.peek("a@brand.example")).toEqual({ kind: "unknown" });
    expect(storage.read()).toBeNull();
  });

  it("drops unsafe URLs read back from storage", () => {
    const storage = memoryLogoStorage();
    storage.write({
      "bad.example": { url: "javascript:alert(1)", at: 1_000_000 },
      "ok.example": { url: LOGO, at: 1_000_000 },
    });
    const cache = new BrandLogoCache({ resolve: async () => ({ kind: "none" }), storage, now: () => 1_000_000 });
    expect(cache.peek("a@bad.example")).toEqual({ kind: "unknown" });
    expect(cache.peek("a@ok.example")).toEqual({ kind: "logo", url: LOGO });
  });

  it("notifies subscribers when a lookup lands", async () => {
    const { cache } = setup();
    const listener = vi.fn();
    cache.subscribe(listener);
    const before = cache.getVersion();
    await cache.request("a@brand.example");
    expect(listener).toHaveBeenCalled();
    expect(cache.getVersion()).toBeGreaterThan(before);
  });

  it("answers addresses without a usable domain as none, without a lookup", async () => {
    const { cache, resolve } = setup();
    expect(cache.peek("registry@example")).toEqual({ kind: "none" });
    expect(await cache.request("nobody")).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});

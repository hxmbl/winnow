import { describe, expect, it, vi } from "vitest";
import {
  BrandLogoCache,
  LOGO_HIT_TTL_MS,
  LOGO_MISS_TTL_MS,
  LOGO_RETRY_MS,
  MAX_QUEUED_LOOKUPS,
  localLogoStorage,
  memoryLogoStorage,
  sanitise,
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

describe("BrandLogoCache, hardened", () => {
  it("settles queued lookups with null when cleared, instead of leaving them hanging", async () => {
    const gate: (() => void)[] = [];
    const cache = new BrandLogoCache({
      resolve: () => new Promise<TxtAnswer>((done) => gate.push(() => done({ kind: "none" }))),
      storage: memoryLogoStorage(),
      concurrency: 1,
    });
    const first = cache.request("a@one.example");
    const queued = cache.request("a@two.example");
    cache.clear();
    expect(await queued).toBeNull();
    gate.forEach((open) => open());
    expect(await first).toBeNull();
  });

  it("does not let a lookup from before a clear delete a newer one for the same domain", async () => {
    const gate: (() => void)[] = [];
    const resolve = vi.fn(
      () => new Promise<TxtAnswer>((done) => gate.push(() => done({ kind: "records", records: [`v=BIMI1; l=${LOGO}`] }))),
    );
    const cache = new BrandLogoCache({ resolve, storage: memoryLogoStorage(), concurrency: 4 });
    const old = cache.request("a@brand.example");
    cache.clear();
    const fresh = cache.request("a@brand.example");
    gate.shift()?.();
    await old;
    // The newer lookup is still the one in flight: a third request joins it.
    const joined = cache.request("a@brand.example");
    expect(joined).toBe(fresh);
    gate.forEach((open) => open());
    expect(await fresh).toBe(LOGO);
  });

  it("caps the queue, dropping the oldest requests unremembered", async () => {
    const resolve = vi.fn(() => new Promise<TxtAnswer>(() => undefined));
    const cache = new BrandLogoCache({ resolve, storage: memoryLogoStorage(), concurrency: 1 });
    const requests = Array.from({ length: MAX_QUEUED_LOOKUPS + 6 }, (_, i) => cache.request(`a@d${i}.example`));
    // The first started at once; of the rest, the five oldest queued are dropped.
    for (let i = 1; i <= 5; i += 1) expect(await requests[i]).toBeNull();
    expect(cache.peek("a@d1.example")).toEqual({ kind: "unknown" });
  });

  it("does not look anything up offline, and does not remember that as a failure", async () => {
    let online = false;
    const resolve = vi.fn(async (): Promise<TxtAnswer> => ({ kind: "records", records: [`v=BIMI1; l=${LOGO}`] }));
    const cache = new BrandLogoCache({ resolve, storage: memoryLogoStorage(), isOnline: () => online });
    expect(await cache.request("a@brand.example")).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    online = true;
    expect(await cache.request("a@brand.example")).toBe(LOGO);
  });

  it("retries failed lookups on retryFailed, and tells subscribers", async () => {
    let fail = true;
    const resolve = vi.fn(async (): Promise<TxtAnswer> => {
      if (fail) throw new Error("offline");
      return { kind: "records", records: [`v=BIMI1; l=${LOGO}`] };
    });
    const cache = new BrandLogoCache({ resolve, storage: memoryLogoStorage() });
    expect(await cache.request("a@brand.example")).toBeNull();
    fail = false;
    expect(await cache.request("a@brand.example")).toBeNull(); // still cooling down
    const listener = vi.fn();
    cache.subscribe(listener);
    cache.retryFailed();
    expect(listener).toHaveBeenCalled();
    expect(await cache.request("a@brand.example")).toBe(LOGO);
  });
});

describe("sanitise (what storage is trusted with)", () => {
  const now = 10_000_000_000;

  it("throws nothing and keeps nothing for junk", () => {
    expect(sanitise(null, now)).toEqual({});
    expect(sanitise("nope", now)).toEqual({});
    expect(sanitise([{ url: null, at: 1 }], now)).toEqual({});
  });

  it("drops keys that are not domains", () => {
    const out = sanitise({ "__proto__": { url: null, at: 1 }, "no dots": { url: null, at: 1 }, "ok.example": { url: null, at: 1 } }, now);
    expect(Object.keys(out)).toEqual(["ok.example"]);
  });

  it("drops times that are not finite or are in the future", () => {
    const out = sanitise(
      {
        "nan.example": { url: null, at: Number.NaN },
        "future.example": { url: null, at: now + 7 * 24 * 60 * 60 * 1000 },
        "fine.example": { url: null, at: now - 1 },
      },
      now,
    );
    expect(Object.keys(out)).toEqual(["fine.example"]);
  });

  it("drops URLs that would not be accepted now", () => {
    const out = sanitise(
      { "a.example": { url: "http://insecure.example/x.svg", at: 1 }, "b.example": { url: "javascript:alert(1)", at: 1 } },
      now,
    );
    expect(out).toEqual({});
  });
});

describe("localLogoStorage over quota", () => {
  it("keeps the newest half rather than nothing, and removes the key when nothing fits", () => {
    const writes: string[] = [];
    let limit = Number.POSITIVE_INFINITY;
    let removed = false;
    const fake = {
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        if (value.length > limit) throw new DOMException("full", "QuotaExceededError");
        writes.push(value);
      },
      removeItem: () => {
        removed = true;
      },
    };
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true });
    try {
      const storage = localLogoStorage("k");
      const entries = Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`d${i}.example`, { url: null, at: i }]),
      );
      limit = JSON.stringify(Object.fromEntries(Object.entries(entries).slice(0, 4))).length;
      storage.write(entries);
      const kept = Object.keys(JSON.parse(writes[writes.length - 1]) as object);
      expect(kept.length).toBeLessThanOrEqual(4);
      expect(kept).toContain("d7.example"); // the newest survives
      expect(kept).not.toContain("d0.example");
      limit = 0;
      storage.write(entries);
      expect(removed).toBe(true);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

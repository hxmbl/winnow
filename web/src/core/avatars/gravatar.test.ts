import { describe, expect, it, vi } from "vitest";
import {
  GRAVATAR_STORAGE_KEY,
  GravatarCache,
  gravatarAddress,
  gravatarBase,
  gravatarHash,
  gravatarImageUrl,
  isGravatarUrl,
  isNoReplyAddress,
  sanitiseGravatars,
  sha256Hex,
} from "./gravatar";
import { LOGO_HIT_TTL_MS, LOGO_MISS_TTL_MS, LOGO_RETRY_MS, MAX_QUEUED_LOOKUPS, memoryLogoStorage } from "./logoCache";

// Gravatar's own documented example.
const DOC_ADDRESS = "MyEmailAddress@example.com ";
const DOC_HASH = "84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee";

describe("Gravatar hashing", () => {
  it("is SHA-256 hex of the trimmed, lower-cased address", async () => {
    expect(await sha256Hex("myemailaddress@example.com")).toBe(DOC_HASH);
    expect(await gravatarHash(DOC_ADDRESS)).toBe(DOC_HASH);
    expect(await gravatarHash("  MYEMAILADDRESS@EXAMPLE.COM")).toBe(DOC_HASH);
  });

  it("builds the d=404 URL at twice the display size", () => {
    const base = gravatarBase(DOC_HASH);
    expect(base).toBe(`https://gravatar.com/avatar/${DOC_HASH}`);
    expect(gravatarImageUrl(base, 32)).toBe(`https://gravatar.com/avatar/${DOC_HASH}?d=404&s=64`);
    expect(gravatarImageUrl(base, 36)).toBe(`https://gravatar.com/avatar/${DOC_HASH}?d=404&s=72`);
    expect(isGravatarUrl(gravatarImageUrl(base, 32))).toBe(true);
    expect(isGravatarUrl("https://gravatar.com.evil.example/avatar/x")).toBe(false);
    expect(isGravatarUrl("https://lh3.googleusercontent.com/a/x")).toBe(false);
  });
});

describe("which addresses are looked up", () => {
  it("normalises a real address", () => {
    expect(gravatarAddress(" Ana.Lima@Example.COM ")).toBe("ana.lima@example.com");
    expect(gravatarAddress("ana+lists@example.com")).toBe("ana+lists@example.com");
  });

  it("skips malformed addresses", () => {
    for (const bad of ["", "ana", "@example.com", "ana@", "ana@localhost", "ana@example", "a b@example.com", "<ana@example.com>", "ana@exa mple.com", ".ana@example.com", "ana.@example.com", "ana@example.com>"]) {
      expect(gravatarAddress(bad), bad).toBeNull();
    }
  });

  it("skips no-reply mailboxes", () => {
    for (const machine of [
      "noreply@example.com",
      "no-reply@example.com",
      "No_Reply@example.com",
      "donotreply@example.com",
      "do-not-reply@example.com",
      "dontreply@example.com",
      "noreply+abc123@example.com",
      "no-reply-billing@example.com",
      "mailer-daemon@example.com",
      "postmaster@example.com",
      "bounce@example.com",
    ]) {
      expect(isNoReplyAddress(machine), machine).toBe(true);
      expect(gravatarAddress(machine), machine).toBeNull();
    }
  });

  it("does not mistake a person for a no-reply mailbox", () => {
    for (const person of ["noreen@example.com", "reply@example.com", "nora.reply@example.com", "donald@example.com"]) {
      expect(isNoReplyAddress(person), person).toBe(false);
      expect(gravatarAddress(person), person).toBe(person);
    }
  });
});

function setup(options: { hits?: string[]; fail?: boolean; online?: () => boolean } = {}) {
  let now = 1_000_000;
  const hits = new Set(options.hits ?? []);
  const hash = vi.fn(async (address: string) => (address === "ana@example.com" ? "a".repeat(64) : "b".repeat(64)));
  const probe = vi.fn(async (url: string) => {
    if (options.fail) throw new Error("offline");
    return [...hits].some((h) => url.includes(h));
  });
  const storage = memoryLogoStorage();
  const cache = new GravatarCache({ probe, hash, storage, now: () => now, isOnline: options.online });
  return { cache, probe, hash, storage, advance: (ms: number) => (now += ms) };
}

describe("Gravatar cache", () => {
  it("probes the d=404 URL and remembers a hit as its base", async () => {
    const { cache, probe } = setup({ hits: ["a".repeat(64)] });
    expect(cache.peek("Ana@Example.com")).toEqual({ kind: "unknown" });
    expect(await cache.request("Ana@Example.com")).toBe(gravatarBase("a".repeat(64)));
    expect(probe).toHaveBeenCalledWith(`https://gravatar.com/avatar/${"a".repeat(64)}?d=404&s=64`);
    expect(cache.peek("ana@example.com")).toEqual({ kind: "logo", url: gravatarBase("a".repeat(64)) });
    await cache.request("ana@example.com");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("caches a miss for a day and asks again after", async () => {
    const { cache, probe, advance } = setup();
    expect(await cache.request("bo@example.com")).toBeNull();
    expect(cache.peek("bo@example.com")).toEqual({ kind: "none" });
    advance(LOGO_MISS_TTL_MS - 1);
    expect(await cache.request("bo@example.com")).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
    advance(2);
    expect(cache.peek("bo@example.com")).toEqual({ kind: "unknown" });
    await cache.request("bo@example.com");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("keeps a hit for a week", async () => {
    const { cache, advance } = setup({ hits: ["a".repeat(64)] });
    await cache.request("ana@example.com");
    advance(LOGO_HIT_TTL_MS - 1);
    expect(cache.peek("ana@example.com").kind).toBe("logo");
    advance(2);
    expect(cache.peek("ana@example.com").kind).toBe("unknown");
  });

  it("never hashes or probes a skipped address", async () => {
    const { cache, probe, hash } = setup();
    expect(cache.peek("noreply@example.com")).toEqual({ kind: "none" });
    expect(await cache.request("noreply@example.com")).toBeNull();
    expect(await cache.request("not an address")).toBeNull();
    expect(hash).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not remember a failure as a miss, and retries after the cool-down", async () => {
    const { cache, probe, advance } = setup({ fail: true });
    expect(await cache.request("ana@example.com")).toBeNull();
    expect(cache.peek("ana@example.com")).toEqual({ kind: "unknown" });
    await cache.request("ana@example.com");
    expect(probe).toHaveBeenCalledTimes(1);
    advance(LOGO_RETRY_MS + 1);
    await cache.request("ana@example.com");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("looks nothing up offline", async () => {
    let online = false;
    const { cache, probe } = setup({ online: () => online });
    expect(await cache.request("ana@example.com")).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    online = true;
    await cache.request("ana@example.com");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("ignores a lookup that lands after the setting was turned off", async () => {
    let finish: (hit: boolean) => void = () => undefined;
    const storage = memoryLogoStorage();
    const cache = new GravatarCache({
      probe: () => new Promise<boolean>((resolve) => (finish = resolve)),
      hash: async () => "a".repeat(64),
      storage,
    });
    const pending = cache.request("ana@example.com");
    await Promise.resolve();
    await Promise.resolve();
    cache.clear();
    finish(true);
    await pending;
    expect(cache.peek("ana@example.com")).toEqual({ kind: "unknown" });
    expect(storage.read()).toBeNull();
  });

  it("caps the queue, dropping the oldest requests unanswered", async () => {
    const cache = new GravatarCache({
      probe: () => new Promise<boolean>(() => undefined),
      hash: sha256Hex,
      storage: memoryLogoStorage(),
      concurrency: 1,
    });
    const requests = Array.from({ length: MAX_QUEUED_LOOKUPS + 5 }, (_, i) => cache.request(`person${i}@example.com`));
    // The first one is running and the next hundred wait; the oldest four of those
    // waiting were dropped, settled as "no picture" rather than left hanging.
    const dropped = await Promise.all(requests.slice(1, 5));
    expect(dropped).toEqual([null, null, null, null]);
    expect(cache.peek("person1@example.com")).toEqual({ kind: "unknown" });
  });

  it("stores under its own key", () => {
    expect(GRAVATAR_STORAGE_KEY).toBe("winnow.gravatars.v1");
  });
});

describe("stored Gravatar answers", () => {
  const now = 10_000_000;
  const base = gravatarBase("c".repeat(64));

  it("keeps addresses with a base or a miss", () => {
    expect(
      sanitiseGravatars({ "ana@example.com": { url: base, at: now - 5 }, "bo@example.com": { url: null, at: now - 5 } }, now),
    ).toEqual({ "ana@example.com": { url: base, at: now - 5 }, "bo@example.com": { url: null, at: now - 5 } });
  });

  it("drops anything else", () => {
    const out = sanitiseGravatars(
      {
        "Ana@Example.com": { url: base, at: now },
        "noreply@example.com": { url: null, at: now },
        "cy@example.com": { url: "https://evil.example/x.png", at: now },
        "di@example.com": { url: `${base}?d=mp`, at: now },
        "ed@example.com": { url: base, at: now + 48 * 60 * 60 * 1000 },
        "fi@example.com": { url: base, at: Number.NaN },
        "gu@example.com": "yes",
      },
      now,
    );
    expect(out).toEqual({});
    expect(sanitiseGravatars([1, 2], now)).toEqual({});
    expect(sanitiseGravatars(null, now)).toEqual({});
  });
});

/**
 * Cache scale guard rails.
 *
 * The sibling of `store/scale.test.ts`, and the guard for the other regression
 * that came in with the React rewrite: sync upserts the cache every
 * `BATCH_SIZE` (25) messages, and the original implementation re-read and
 * re-serialised the *entire* mailbox on each one.
 *
 * Measured before the fix, by driving `localCache.upsert` the way the sync loop
 * does:
 *
 *     messages  upserts    write ms
 *          250        10        20.7
 *         1000        40       241.3
 *         2500       100      1360.9
 *
 * Four times the messages, eleven times the time — the n²/25 signature. After the
 * fix the upsert loop is flat and the mailbox is serialised exactly once, on
 * `flush()`.
 *
 * These are wall-clock ceilings rather than work counts because the shape of the
 * cost is "how many times did we serialise the mailbox", and the cheapest honest
 * proxy for that is time. `upsertsAreCheapWhenCoalesced` pins the same property
 * deterministically by counting serialisations through the storage stub.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { localCache } from "./session";
import { DEMO_EMAILS } from "../data/demo";
import type { Email } from "../model/email";

/**
 * A mailbox the size a real account reaches, built by cycling the demo seed.
 *
 * `offset` shifts the generated ids, so a second call produces *different*
 * messages rather than overwriting the first call's.
 */
function synth(n: number, offset = 0): Email[] {
  const out: Email[] = [];
  for (let i = 0; i < n; i += 1) {
    const base = DEMO_EMAILS[(i + offset) % DEMO_EMAILS.length]!;
    out.push({
      ...base,
      id: offset + i + 1,
      gmailId: `synthetic-${offset + i}`,
      bodyHtml: `<div>${"<p>A message body with enough words in it to be realistic. </p>".repeat(30)}</div>`,
    });
  }
  return out;
}

/** An in-memory `Storage` that counts writes and can enforce a quota. */
function fakeStorage(quotaBytes = Number.POSITIVE_INFINITY) {
  const map = new Map<string, string>();
  let writes = 0;
  let serialised = 0;
  let bytes = 0;
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes += 1;
      serialised += v.length;
      const prev = map.get(k);
      bytes += v.length - (prev?.length ?? 0);
      if (bytes > quotaBytes) {
        const error = new Error("quota exceeded");
        error.name = "QuotaExceededError";
        throw error;
      }
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
    /** How many times storage was written at all. */
    writes: () => writes,
    /** Total characters handed to storage — the proxy for serialisation volume. */
    serialised: () => serialised,
    bytes: () => [...map.values()].reduce((s, v) => s + v.length, 0),
  };
}

function install(storage: ReturnType<typeof fakeStorage>): void {
  globalThis.localStorage = storage as unknown as Storage;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("scale: cache writes", () => {
  it("a 2,500-message sync does not serialise the mailbox 100 times", async () => {
    const emails = synth(2500);
    const storage = fakeStorage();
    install(storage);

    const cache = localCache("scale");
    const BATCH = 25;
    for (let i = 0; i < emails.length; i += BATCH) {
      await cache.upsert(emails.slice(i, i + BATCH));
    }
    await cache.flush();

    // Before the fix this was ~100 writes totalling ~600MB of serialisation
    // (2500 messages × 2,374 bytes × 100 upserts). Coalescing makes it one.
    expect(storage.writes()).toBeLessThanOrEqual(2);

    // And the blob that landed is the whole mailbox, not a truncated one.
    const round = await cache.all();
    expect(round.length).toBe(2500);
  });

  it("upserts stay cheap as the mailbox grows, instead of compounding", async () => {
    // The shape assertion: doubling the message count must not quadruple the work.
    // Before the fix these two rows read ~241ms and ~1361ms (5.6x for 2.5x the mail).
    const measure = async (n: number): Promise<number> => {
      const emails = synth(n);
      const storage = fakeStorage();
      install(storage);
      const cache = localCache(`scale-${n}`);
      const start = performance.now();
      for (let i = 0; i < emails.length; i += 25) {
        await cache.upsert(emails.slice(i, i + 25));
      }
      await cache.flush();
      return performance.now() - start;
    };

    await measure(500); // warm the JIT
    const small = await measure(1000);
    const large = await measure(4000);

    // Four times the mail. Before the fix this ratio was ~14x; a quadratic would be
    // ~16x and a linear one ~4x. The absolute floor exists because the ratio alone is
    // fragile on a loaded machine — two slow runs can divide out to something that
    // looks linear. 1s is well under the ~2.9s a reintroduced quadratic measures here
    // and well over the noise, so it catches the regression without flaking.
    expect(large).toBeLessThan(Math.max(small * 8, 1000));
  });

  it("reports a quota failure instead of swallowing it", async () => {
    // The old `writeAll` caught and discarded everything, so past roughly 2,000
    // messages the app reported a healthy sync while the offline cache had never
    // been written once — and the comment claimed the next sync would rebuild it.
    // It cannot: the next sync hits the same wall.
    const emails = synth(2500);
    install(fakeStorage(2 * 1024 * 1024)); // 2MB ceiling

    const cache = localCache("quota");
    for (let i = 0; i < emails.length; i += 25) {
      await cache.upsert(emails.slice(i, i + 25));
    }

    await expect(cache.flush()).rejects.toThrow();
  });

  it("a cache that fits reports a clean flush", async () => {
    install(fakeStorage());
    const cache = localCache("ok");
    await cache.upsert(synth(200));
    await expect(cache.flush()).resolves.toBeUndefined();
    expect((await cache.all()).length).toBe(200);
  });
});

describe("scale: cache semantics", () => {
  it("reading the cache does not reorder it", async () => {
    // `all()` sorts by recency. With a plain-array mirror that sort was in-place on
    // the parsed copy and harmless; with a live mirror it would silently reorder the
    // canonical store as a side effect of reading. This is the regression that
    // swapping in a mirror would have introduced.
    install(fakeStorage());
    const cache = localCache("order");
    await cache.upsert(synth(50));
    await cache.flush();

    const first = await cache.gmailIds();
    await cache.all();
    await cache.all();
    const second = await cache.gmailIds();

    expect(second).toEqual(first);
  });

  it("coalesced writes are not lost when a second burst arrives", async () => {
    install(fakeStorage());
    const cache = localCache("burst");
    await cache.upsert(synth(20));
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the timer land
    await cache.upsert(synth(20, 100));
    await cache.flush();

    expect((await cache.all()).length).toBe(40);
  });
});
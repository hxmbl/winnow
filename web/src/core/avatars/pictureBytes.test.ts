import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  CAPTURE_RETRY_MS,
  deletePictureBytes,
  indexedDbPictureBytesStorage,
  isPictureData,
  MAX_PICTURE_DATA_CHARS,
  memoryPictureBytesStorage,
  PICTURE_BYTES_FRESH_MS,
  PICTURE_BYTES_MAX_AGE_MS,
  PICTURE_BYTES_PX,
  pictureBytesDbName,
  PictureBytesCache,
  pictureKey,
  sanitisePictures,
  TOUCH_PERSIST_MS,
  type CapturePicture,
  type PictureBytesStorage,
  type PictureKind,
  type StoredPicture,
} from "./pictureBytes";

const DATA = "data:image/webp;base64,UklGRg==";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const url = (n: number | string) => `https://pics.example/${n}.png`;

/** A clock the test moves. */
function clock(start = 1_000_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** A capture the test controls: answers `DATA` unless told otherwise, and counts calls. */
function capturer(answer: (u: string) => string | null = () => DATA) {
  const calls: string[] = [];
  const capture: CapturePicture = async (u, px) => {
    expect(px).toBe(PICTURE_BYTES_PX);
    calls.push(u);
    return answer(u);
  };
  return { capture, calls };
}

/** A capture held open until the test releases it. */
function heldCapture() {
  const pending: { url: string; release: (value: string | null) => void }[] = [];
  const capture: CapturePicture = (u) => new Promise((resolve) => pending.push({ url: u, release: resolve }));
  return { capture, pending };
}

function record(key: string, extra: Partial<StoredPicture> = {}): StoredPicture {
  return { key, kind: "contact", data: DATA, savedAt: 1_000_000_000_000, usedAt: 1_000_000_000_000, ...extra };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("picture keys and data", () => {
  it("keys https URLs only, and one Gravatar per person whatever its size", () => {
    expect(pictureKey("https://lh3.googleusercontent.com/a/x=s96-c")).toBe("https://lh3.googleusercontent.com/a/x=s96-c");
    const base = `https://gravatar.com/avatar/${"a".repeat(64)}`;
    expect(pictureKey(`${base}?d=404&s=64`)).toBe(base);
    expect(pictureKey(`${base}?d=404&s=72`)).toBe(base);
    expect(pictureKey("http://plain.example/a.png")).toBeNull();
    expect(pictureKey("/demo-avatars/ada.svg")).toBeNull();
    expect(pictureKey(DATA)).toBeNull();
    expect(pictureKey("https://user:pw@x.example/a.png")).toBeNull();
    // A logo's query is part of its address and is kept.
    expect(pictureKey("https://brand.example/logo.svg?v=2")).toBe("https://brand.example/logo.svg?v=2");
  });

  it("keeps only small image data URLs", () => {
    expect(isPictureData(DATA)).toBe(true);
    expect(isPictureData(PNG)).toBe(true);
    expect(isPictureData("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isPictureData("https://x.example/a.png")).toBe(false);
    expect(isPictureData(`data:image/png;base64,${"A".repeat(MAX_PICTURE_DATA_CHARS)}`)).toBe(false);
  });

  it("one database per account", () => {
    expect(pictureBytesDbName("abcd1234")).toBe("winnow-pictures@abcd1234");
    expect(pictureBytesDbName(null)).toBe("winnow-pictures");
  });

  it("drops what storage should not have held", () => {
    const now = 1_000_000_000_000;
    const kept = sanitisePictures(
      [
        record(url(1)),
        record("http://insecure.example/a.png"),
        record(url(2), { kind: "favicon" as PictureKind }),
        record(url(3), { data: "javascript:alert(1)" }),
        record(url(4), { savedAt: now + 2 * 24 * 60 * 60 * 1000 }),
        record(url(5), { savedAt: now - PICTURE_BYTES_MAX_AGE_MS }),
        record(url(6), { usedAt: Number.NaN }),
        null,
        "junk",
      ],
      now,
    );
    expect(kept.map((r) => r.key)).toEqual([url(1), url(6)]);
    expect(kept[1].usedAt).toBe(kept[1].savedAt);
    expect(sanitisePictures({ not: "a list" }, now)).toEqual([]);
  });
});

describe("the picture-bytes cache", () => {
  it("captures a picture once, then draws it from memory", async () => {
    const t = clock();
    const { capture, calls } = capturer();
    const cache = new PictureBytesCache({ storage: memoryPictureBytesStorage(), capture, now: t.now });
    await cache.ready;
    expect(cache.get(url(1))).toBeNull();
    expect(await cache.remember(url(1), "contact")).toBe(true);
    expect(cache.get(url(1))?.data).toBe(DATA);
    expect(cache.isStale(url(1))).toBe(false);
    expect(await cache.remember(url(1), "contact")).toBe(false);
    expect(calls).toEqual([url(1)]);
  });

  it("warms from storage at startup, so the copy is there synchronously after `ready`", async () => {
    const t = clock();
    const storage = memoryPictureBytesStorage();
    const first = new PictureBytesCache({ storage, capture: capturer().capture, now: t.now });
    await first.remember(url(1), "logo");
    const second = new PictureBytesCache({ storage, capture: capturer().capture, now: t.now });
    expect(second.get(url(1))).toBeNull();
    await second.ready;
    expect(second.get(url(1))).toMatchObject({ kind: "logo", data: DATA });
  });

  it("keeps the most recently used, dropping the least recently used beyond the cap", async () => {
    const t = clock();
    const storage = memoryPictureBytesStorage();
    const cache = new PictureBytesCache({ storage, capture: capturer().capture, now: t.now, maxEntries: 3 });
    await cache.ready;
    for (const n of [1, 2, 3]) {
      await cache.remember(url(n), "contact");
      t.advance(TOUCH_PERSIST_MS);
    }
    // 1 is drawn again: it is now the most recent.
    cache.touch(url(1));
    t.advance(TOUCH_PERSIST_MS);
    await cache.remember(url(4), "contact");
    expect(cache.get(url(2))).toBeNull();
    expect(cache.keys()).toEqual([url(4), url(1), url(3)]);
    await flush();
    expect([...storage.records.keys()].sort()).toEqual([url(1), url(3), url(4)].sort());
  });

  it("writes a touch back at most once an hour", async () => {
    const t = clock();
    const storage = memoryPictureBytesStorage();
    const cache = new PictureBytesCache({ storage, capture: capturer().capture, now: t.now });
    await cache.remember(url(1), "contact");
    const savedAt = storage.records.get(url(1))!.usedAt;
    t.advance(TOUCH_PERSIST_MS - 1);
    cache.touch(url(1));
    await flush();
    expect(storage.records.get(url(1))!.usedAt).toBe(savedAt);
    t.advance(1);
    cache.touch(url(1));
    await flush();
    expect(storage.records.get(url(1))!.usedAt).toBe(savedAt + TOUCH_PERSIST_MS);
  });

  it("serves a stale copy and refreshes it; drops one past the maximum age on load", async () => {
    const t = clock();
    const storage = memoryPictureBytesStorage();
    let answer = DATA;
    const { capture, calls } = capturer(() => answer);
    const cache = new PictureBytesCache({ storage, capture, now: t.now });
    await cache.remember(url(1), "gravatar");
    t.advance(PICTURE_BYTES_FRESH_MS);
    expect(cache.isStale(url(1))).toBe(true);
    // Stale is still drawn: that is what makes it work offline.
    expect(cache.get(url(1))?.data).toBe(DATA);
    answer = PNG;
    expect(await cache.remember(url(1), "gravatar")).toBe(true);
    expect(cache.get(url(1))?.data).toBe(PNG);
    expect(calls).toHaveLength(2);

    t.advance(PICTURE_BYTES_MAX_AGE_MS);
    const later = new PictureBytesCache({ storage, capture, now: t.now });
    await later.ready;
    expect(later.get(url(1))).toBeNull();
    expect(storage.records.size).toBe(0);
  });

  it("captures nothing offline, and keeps a stale copy when a refresh fails", async () => {
    const t = clock();
    let online = true;
    let answer: string | null = DATA;
    const { capture, calls } = capturer(() => answer);
    const cache = new PictureBytesCache({ storage: memoryPictureBytesStorage(), capture, now: t.now, isOnline: () => online });
    online = false;
    expect(await cache.remember(url(1), "logo")).toBe(false);
    expect(calls).toEqual([]);
    online = true;
    await cache.remember(url(1), "logo");
    t.advance(PICTURE_BYTES_FRESH_MS);
    answer = null;
    expect(await cache.remember(url(1), "logo")).toBe(false);
    expect(cache.get(url(1))?.data).toBe(DATA);
  });

  it("does not retry a picture that cannot be read back (CORS) until the cool-down passes", async () => {
    const t = clock();
    const { capture, calls } = capturer(() => null);
    const cache = new PictureBytesCache({ storage: memoryPictureBytesStorage(), capture, now: t.now });
    expect(await cache.remember(url(1), "logo")).toBe(false);
    expect(await cache.remember(url(1), "logo")).toBe(false);
    expect(calls).toHaveLength(1);
    t.advance(CAPTURE_RETRY_MS);
    await cache.remember(url(1), "logo");
    expect(calls).toHaveLength(2);
  });

  it("refuses data that is not a small image, and URLs it never keeps", async () => {
    const { capture, calls } = capturer(() => "data:image/svg+xml;base64,PHN2Zz4=");
    const cache = new PictureBytesCache({ storage: memoryPictureBytesStorage(), capture });
    expect(await cache.remember(url(1), "logo")).toBe(false);
    expect(cache.get(url(1))).toBeNull();
    expect(await cache.remember("/demo-avatars/ada.svg", "contact")).toBe(false);
    expect(calls).toEqual([url(1)]);
  });

  it("runs two captures at a time and asks once per URL", async () => {
    const { capture, pending } = heldCapture();
    const cache = new PictureBytesCache({ storage: memoryPictureBytesStorage(), capture });
    await cache.ready;
    const answers = [1, 1, 2, 3].map((n) => cache.remember(url(n), "contact"));
    expect(pending.map((p) => p.url)).toHaveLength(2);
    pending[0].release(DATA);
    await flush();
    expect(pending).toHaveLength(3);
    for (const p of pending.slice(1)) p.release(DATA);
    expect(await Promise.all(answers)).toEqual([true, false, true, true]);
  });

  it("clear forgets memory and storage, and a capture from before it never lands", async () => {
    const { capture, pending } = heldCapture();
    const storage = memoryPictureBytesStorage();
    storage.records.set(url(9), record(url(9)));
    const cache = new PictureBytesCache({ storage, capture, now: () => 1_000_000_000_000 });
    await cache.ready;
    expect(cache.get(url(9))).not.toBeNull();
    const running = cache.remember(url(1), "contact");
    const queued = [cache.remember(url(2), "contact"), cache.remember(url(3), "contact")];
    await cache.clear();
    expect(cache.get(url(9))).toBeNull();
    expect(storage.records.size).toBe(0);
    // The queued one never starts and settles `false`.
    expect(await queued[1]).toBe(false);
    pending[0].release(DATA);
    pending[1].release(DATA);
    expect(await running).toBe(false);
    expect(await queued[0]).toBe(false);
    expect(cache.get(url(1))).toBeNull();
    expect(storage.records.size).toBe(0);
  });

  it("clearKind drops one source only, in memory and storage, including mid-capture", async () => {
    const { capture, pending } = heldCapture();
    const storage = memoryPictureBytesStorage();
    storage.records.set(url("g"), record(url("g"), { kind: "gravatar" }));
    storage.records.set(url("l"), record(url("l"), { kind: "logo" }));
    storage.records.set(url("c"), record(url("c"), { kind: "contact" }));
    const cache = new PictureBytesCache({ storage, capture, now: () => 1_000_000_000_000 });
    await cache.ready;
    const running = cache.remember(url("g2"), "gravatar");
    await cache.clearKind("gravatar");
    pending[0].release(DATA);
    expect(await running).toBe(false);
    expect(cache.get(url("g"))).toBeNull();
    expect(cache.get(url("g2"))).toBeNull();
    expect(cache.get(url("l"))).not.toBeNull();
    expect([...storage.records.keys()].sort()).toEqual([url("c"), url("l")].sort());
    // A new capture after the clear (the switch back on) is kept as usual.
    const again = cache.remember(url("g3"), "gravatar");
    pending[1].release(DATA);
    expect(await again).toBe(true);
  });

  it("a kind cleared while the startup read is running stays cleared", async () => {
    const inner = memoryPictureBytesStorage();
    inner.records.set(url("l"), record(url("l"), { kind: "logo" }));
    let releaseRead: () => void = () => undefined;
    const storage: PictureBytesStorage = {
      ...inner,
      readAll: async () => {
        const all = await inner.readAll();
        await new Promise<void>((resolve) => (releaseRead = resolve));
        return all;
      },
    };
    const cache = new PictureBytesCache({ storage, capture: capturer().capture, now: () => 1_000_000_000_000 });
    await flush();
    await cache.clearKind("logo");
    releaseRead();
    await cache.ready;
    expect(cache.get(url("l"))).toBeNull();
  });

  it("notifies subscribers when the warm lands and when a copy is kept", async () => {
    const cache = new PictureBytesCache({ storage: memoryPictureBytesStorage(), capture: capturer().capture });
    let seen = 0;
    cache.subscribe(() => (seen += 1));
    await cache.ready;
    expect(seen).toBe(1);
    await cache.remember(url(1), "contact");
    expect(seen).toBe(2);
    expect(cache.getVersion()).toBeGreaterThanOrEqual(2);
  });

  it("a storage that fails is an empty cache, never an error", async () => {
    const broken: PictureBytesStorage = {
      readAll: () => Promise.reject(new Error("no")),
      put: () => Promise.reject(new Error("no")),
      remove: () => Promise.reject(new Error("no")),
      removeKind: () => Promise.reject(new Error("no")),
      clear: () => Promise.reject(new Error("no")),
    };
    const cache = new PictureBytesCache({ storage: broken, capture: capturer().capture });
    await cache.ready;
    expect(await cache.remember(url(1), "contact")).toBe(true);
    expect(cache.get(url(1))?.data).toBe(DATA);
    await cache.clearKind("contact");
    await cache.clear();
    expect(cache.get(url(1))).toBeNull();
  });
});

describe("the IndexedDB picture storage", () => {
  it("round-trips records, removes by key and by kind", async () => {
    const storage = indexedDbPictureBytesStorage("winnow-pictures@test", new IDBFactory());
    await storage.put(record(url(1)));
    await storage.put(record(url(2), { kind: "logo" }));
    await storage.put(record(url(3), { kind: "logo" }));
    expect((await storage.readAll()).map((r) => r.key).sort()).toEqual([url(1), url(2), url(3)]);
    expect((await storage.removeKind("logo")).sort()).toEqual([url(2), url(3)]);
    await storage.remove([url(1)]);
    expect(await storage.readAll()).toEqual([]);
  });

  it("keeps pictures across cache instances, one database per account", async () => {
    const idb = new IDBFactory();
    const t = clock();
    const a = new PictureBytesCache({ storage: indexedDbPictureBytesStorage(pictureBytesDbName("aaaa"), idb), capture: capturer().capture, now: t.now });
    await a.remember(url(1), "contact");
    const b = new PictureBytesCache({ storage: indexedDbPictureBytesStorage(pictureBytesDbName("bbbb"), idb), capture: capturer().capture, now: t.now });
    await b.ready;
    expect(b.get(url(1))).toBeNull();
    const again = new PictureBytesCache({ storage: indexedDbPictureBytesStorage(pictureBytesDbName("aaaa"), idb), capture: capturer().capture, now: t.now });
    await again.ready;
    expect(again.get(url(1))?.data).toBe(DATA);
  });

  it("clear deletes the account's database, and deletePictureBytes is the bridge's backstop", async () => {
    const idb = new IDBFactory();
    const t = clock();
    const a = new PictureBytesCache({ storage: indexedDbPictureBytesStorage(pictureBytesDbName("aaaa"), idb), capture: capturer().capture, now: t.now });
    const b = new PictureBytesCache({ storage: indexedDbPictureBytesStorage(pictureBytesDbName("bbbb"), idb), capture: capturer().capture, now: t.now });
    await a.remember(url(1), "contact");
    await b.remember(url(1), "contact");
    await a.clear();
    expect(await indexedDbPictureBytesStorage(pictureBytesDbName("aaaa"), idb).readAll()).toEqual([]);
    expect(await indexedDbPictureBytesStorage(pictureBytesDbName("bbbb"), idb).readAll()).toHaveLength(1);
    await deletePictureBytes("bbbb", idb);
    expect(await indexedDbPictureBytesStorage(pictureBytesDbName("bbbb"), idb).readAll()).toEqual([]);
  });
});

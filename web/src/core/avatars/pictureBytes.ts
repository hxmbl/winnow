/**
 * Sender pictures kept as bytes on the device, so an avatar draws at once and offline.
 *
 * The lookup caches (`logoCache.ts`, `gravatar.ts`) and the contacts snapshot only keep
 * *where* a sender's picture is: a URL. The picture itself was left to the WebView's HTTP
 * cache, which nothing controls — so a row showed the monogram until the image came back
 * from the network, and offline it stayed the monogram. This keeps a small copy of each
 * picture actually shown:
 *
 * - **What.** A `PICTURE_BYTES_PX`-pixel square (96: the largest avatar is 36 CSS px,
 *   which this covers at 2x and nearly 3x), drawn the way the avatar shows it and
 *   encoded as a WebP data URL (PNG where the engine cannot write WebP). Typically 2–8 KB;
 *   anything over `MAX_PICTURE_DATA_CHARS` is not kept, and a source over
 *   `MAX_PICTURE_SOURCE_PX` is not captured at all.
 * - **Keyed by the picture's URL** (`pictureKey`), not by sender: a contact who changes
 *   their photo gets a new URL and so a new copy, and the old one ages out. Gravatar's
 *   size option is dropped from the key, so the list's and the reader's sizes share one.
 * - **How many.** The `MAX_PICTURE_BYTES_ENTRIES` (200) most recently *drawn*, least
 *   recently used dropped first. Drawing touches an entry at most once an hour
 *   (`TOUCH_PERSIST_MS`), so scrolling does not turn into a write per row.
 * - **How long.** A copy is fresh for the lookup caches' hit TTL (`LOGO_HIT_TTL_MS`, a
 *   week). A stale copy is still drawn — that is the point offline — and refreshed in
 *   the background the next time it is drawn while online. One not refreshed within
 *   `PICTURE_BYTES_MAX_AGE_MS` (30 days) is dropped when the cache next loads.
 * - **Synchronous to draw.** Everything lives in a `Map` warmed from IndexedDB when the
 *   cache is made (`ready`); `get` never waits. Until the warm lands, an avatar draws
 *   exactly as it did before (the remote URL), then swaps in the copy.
 * - **Never blocks, never breaks.** Capturing is a background load and draw, two at a
 *   time; a picture that cannot be read back as bytes — a host that sends no
 *   `Access-Control-Allow-Origin`, so its canvas is tainted — is simply not cached (and
 *   not tried again for a day this session). Offline, nothing is captured.
 *
 * Privacy, mirroring the lookup caches: one database per account
 * (`winnow-pictures@<id>`); `clear` (sign-out) deletes it; `clearKind` drops one source's
 * copies when its switch goes off ("Gravatar photos", "Show brand logos", or the
 * contacts grant). Serving is gated one level up (`gatedPictureBytes` in
 * `ui/senderPictures.ts`): with Remote images = Never, or a switch off, a cached
 * Gravatar or logo is never drawn, whatever is still on disk.
 *
 * `core/` cannot draw, so the capture (an anonymous `<img>` drawn to a canvas) is
 * passed in; see `ui/pictureCapture.ts`.
 */

import { committed, deleteDatabase, done, lazyConnection, type IdbFactory } from "../offline/idb";
import { LOGO_HIT_TTL_MS, LOGO_MISS_TTL_MS } from "./logoCache";

/** Where a picture came from: what its switch is, and so what turning it off clears. */
export type PictureKind = "contact" | "gravatar" | "logo";

export const PICTURE_KINDS: readonly PictureKind[] = ["contact", "gravatar", "logo"];

/** One kept picture. `data` is a `data:image/…;base64,` URL an `<img>` draws as is. */
export type StoredPicture = {
  key: string;
  kind: PictureKind;
  data: string;
  /** When the bytes were captured: freshness. */
  savedAt: number;
  /** When an avatar last drew them (to the hour): the LRU order. */
  usedAt: number;
};

/** The pixel size kept: the avatar photo size (`AVATAR_PHOTO_PX`). */
export const PICTURE_BYTES_PX = 96;
/** Pictures kept per account, most recently drawn first. */
export const MAX_PICTURE_BYTES_ENTRIES = 200;
/** A copy this young is not captured again: the lookup caches' hit TTL. */
export const PICTURE_BYTES_FRESH_MS = LOGO_HIT_TTL_MS;
/** A copy not refreshed for this long is dropped rather than drawn. */
export const PICTURE_BYTES_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** How often drawing a copy is written back as "used": LRU to the hour. */
export const TOUCH_PERSIST_MS = 60 * 60 * 1000;
/**
 * After a capture that failed while online (CORS, a 404, a picture that drew nothing),
 * how long before the same URL is tried again this session: the lookup caches' miss TTL.
 */
export const CAPTURE_RETRY_MS = LOGO_MISS_TTL_MS;
/**
 * The longest data URL kept, about 18 KB of image: a 96px WebP is 2–8 KB, so this only
 * turns away noise-like pictures. With `MAX_PICTURE_BYTES_ENTRIES` it bounds the whole
 * store at about 4.7 MB per account.
 */
export const MAX_PICTURE_DATA_CHARS = 24_000;
/**
 * The largest source picture captured, px on its longer side. Anything bigger is a photo
 * pretending to be an avatar; it still draws from its URL, but is not decoded onto a
 * canvas just to be thrown away at 96px.
 */
export const MAX_PICTURE_SOURCE_PX = 2048;
/** Captures waiting behind the concurrency limit, at most; the oldest are dropped. */
export const MAX_QUEUED_CAPTURES = 50;
/** A stored time further ahead than this is a bad clock or a bad write. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

const DATA_URL = /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Whether `value` is a picture this cache keeps: a base64 WebP, PNG or JPEG under the cap. */
export function isPictureData(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PICTURE_DATA_CHARS && DATA_URL.test(value);
}

/**
 * The cache key for a picture URL, or `null` for one never cached: anything but https
 * (the demo's bundled pictures, a data URL, a blob). Gravatar's query (`?d=404&s=64`) is
 * only the size and the miss behaviour, so it is dropped: one copy per person.
 */
export function pictureKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  parsed.hash = "";
  if (parsed.hostname === "gravatar.com" || parsed.hostname.endsWith(".gravatar.com")) parsed.search = "";
  return parsed.toString();
}

/** The database an account's pictures live in. `null`/`undefined`: the device's own. */
export function pictureBytesDbName(account?: string | null): string {
  return account ? `winnow-pictures@${account}` : "winnow-pictures";
}

// ── Storage ──────────────────────────────────────────────────────────────

export interface PictureBytesStorage {
  readAll(): Promise<StoredPicture[]>;
  put(record: StoredPicture): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  /** Every record of one kind; resolves to the keys removed. */
  removeKind(kind: PictureKind): Promise<string[]>;
  /** Everything: sign-out. */
  clear(): Promise<void>;
}

/** An in-memory storage with the same behaviour: tests, and hosts without IndexedDB. */
export function memoryPictureBytesStorage(): PictureBytesStorage & { readonly records: Map<string, StoredPicture> } {
  const records = new Map<string, StoredPicture>();
  return {
    records,
    async readAll() {
      return [...records.values()].map((record) => ({ ...record }));
    },
    async put(record) {
      records.set(record.key, { ...record });
    },
    async remove(keys) {
      for (const key of keys) records.delete(key);
    },
    async removeKind(kind) {
      const gone = [...records.values()].filter((record) => record.kind === kind).map((record) => record.key);
      for (const key of gone) records.delete(key);
      return gone;
    },
    async clear() {
      records.clear();
    },
  };
}

const STORE = "pictures";

/**
 * The IndexedDB storage: one object store, keyPath `key`, index `kind`. The connection is
 * opened on first use and dropped by `clear` (which deletes the database), the offline
 * store's pattern (`core/offline/idb.ts`).
 */
export function indexedDbPictureBytesStorage(name: string, idb: IdbFactory | undefined = globalThis.indexedDB): PictureBytesStorage {
  const connection = lazyConnection(
    name,
    1,
    (database) => {
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("kind", "kind");
      }
    },
    idb,
    "the picture cache",
  );
  return {
    async readAll() {
      const database = await connection.open();
      return (await done(database.transaction(STORE).objectStore(STORE).getAll())) as StoredPicture[];
    },
    async put(record) {
      const database = await connection.open();
      const tx = database.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record);
      await committed(tx);
    },
    async remove(keys) {
      if (keys.length === 0) return;
      const database = await connection.open();
      const tx = database.transaction(STORE, "readwrite");
      for (const key of keys) tx.objectStore(STORE).delete(key);
      await committed(tx);
    },
    async removeKind(kind) {
      const database = await connection.open();
      const tx = database.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const keys = (await done(store.index("kind").getAllKeys(kind))).map(String);
      for (const key of keys) store.delete(key);
      await committed(tx);
      return keys;
    },
    async clear() {
      if (!idb) return;
      await connection.close();
      await deleteDatabase(idb, name, "the picture cache");
    },
  };
}

/** The storage for an account on this host: IndexedDB when there is one, else memory. */
export function defaultPictureBytesStorage(account?: string | null): PictureBytesStorage {
  if (typeof globalThis.indexedDB === "undefined") return memoryPictureBytesStorage();
  return indexedDbPictureBytesStorage(pictureBytesDbName(account));
}

/**
 * Delete an account's picture database outright: the bridge's backstop when an account
 * is removed, beside `deleteOfflineData`. Never throws.
 */
export async function deletePictureBytes(account: string, idb: IdbFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (!idb) return;
  await indexedDbPictureBytesStorage(pictureBytesDbName(account), idb).clear().catch(() => undefined);
}

/**
 * What storage held, minus anything it should not have: a key that is not what
 * `pictureKey` makes of it, an unknown kind, data that is not a small image data URL,
 * times that are not finite or are in the future, and copies older than
 * `PICTURE_BYTES_MAX_AGE_MS`. Exported for tests.
 */
export function sanitisePictures(raw: unknown, now: number): StoredPicture[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredPicture[] = [];
  for (const item of raw as Partial<StoredPicture>[]) {
    if (!item || typeof item !== "object") continue;
    const { key, kind, data, savedAt, usedAt } = item;
    if (typeof key !== "string" || pictureKey(key) !== key) continue;
    if (typeof kind !== "string" || !PICTURE_KINDS.includes(kind)) continue;
    if (!isPictureData(data)) continue;
    if (typeof savedAt !== "number" || !Number.isFinite(savedAt) || savedAt > now + FUTURE_SLACK_MS) continue;
    if (now - savedAt >= PICTURE_BYTES_MAX_AGE_MS) continue;
    const used = typeof usedAt === "number" && Number.isFinite(usedAt) && usedAt <= now + FUTURE_SLACK_MS ? usedAt : savedAt;
    out.push({ key, kind, data, savedAt, usedAt: used });
  }
  return out;
}

// ── The cache ────────────────────────────────────────────────────────────

/** Load a picture URL anonymously and draw it to a `px` square data URL; `null` when it cannot be. */
export type CapturePicture = (url: string, px: number) => Promise<string | null>;

export type PictureBytesOptions = {
  storage: PictureBytesStorage;
  capture: CapturePicture;
  now?: () => number;
  /** Whether the network is there; offline nothing is captured. Default always online. */
  isOnline?: () => boolean;
  concurrency?: number;
  maxEntries?: number;
};

export class PictureBytesCache {
  private records = new Map<string, StoredPicture>();
  private readonly failedAt = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly queue: { key: string; run: () => void; drop: () => void }[] = [];
  private active = 0;
  /** Bumped by `clear` and per kind by `clearKind`: a capture from before one never lands. */
  private generation = 0;
  private readonly kindGeneration: Record<PictureKind, number> = { contact: 0, gravatar: 0, logo: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly storage: PictureBytesStorage;
  private readonly capture: CapturePicture;
  private readonly now: () => number;
  private readonly isOnline: () => boolean;
  private readonly concurrency: number;
  private readonly maxEntries: number;
  /** Bumped on every change, for `useSyncExternalStore`. */
  version = 0;
  /** Settles once storage has been read into memory (or failed to be: then it is empty). */
  readonly ready: Promise<void>;

  constructor(options: PictureBytesOptions) {
    this.storage = options.storage;
    this.capture = options.capture;
    this.now = options.now ?? Date.now;
    this.isOnline = options.isOnline ?? (() => true);
    this.concurrency = options.concurrency ?? 2;
    this.maxEntries = options.maxEntries ?? MAX_PICTURE_BYTES_ENTRIES;
    this.ready = this.warm();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** The kept copy of a picture URL, fresh or stale, or `null`. Synchronous; changes nothing. */
  get(url: string): StoredPicture | null {
    const key = pictureKey(url);
    return key ? (this.records.get(key) ?? null) : null;
  }

  /** Whether a copy is due to be captured again: none kept, or older than the fresh TTL. */
  isStale(url: string): boolean {
    const record = this.get(url);
    return !record || this.now() - record.savedAt >= PICTURE_BYTES_FRESH_MS;
  }

  /** An avatar drew this copy: move it up the LRU order (written at most once an hour). */
  touch(url: string): void {
    const record = this.get(url);
    if (!record) return;
    const now = this.now();
    if (now - record.usedAt < TOUCH_PERSIST_MS) return;
    record.usedAt = now;
    void this.storage.put({ ...record }).catch(() => undefined);
  }

  /**
   * Keep a copy of a picture an avatar is drawing: captured in the background unless a
   * fresh copy is kept, one is already being made, it failed recently, or the device is
   * offline. Resolves `true` when a new copy landed; never rejects.
   */
  remember(url: string, kind: PictureKind): Promise<boolean> {
    const key = pictureKey(url);
    if (!key || !PICTURE_KINDS.includes(kind)) return Promise.resolve(false);
    if (!this.isStale(url) || this.inflight.has(key)) return Promise.resolve(false);
    const failed = this.failedAt.get(key);
    if (failed !== undefined && this.now() - failed < CAPTURE_RETRY_MS) return Promise.resolve(false);
    if (!this.isOnline()) return Promise.resolve(false);

    const generation = this.generation;
    const kindGeneration = this.kindGeneration[kind];
    const current = () => generation === this.generation && kindGeneration === this.kindGeneration[kind];
    this.inflight.add(key);
    return new Promise<boolean>((resolve) => {
      const finish = (landed: boolean) => {
        this.inflight.delete(key);
        resolve(landed);
      };
      // Newest first: the rows on screen now are the ones that asked last.
      this.queue.unshift({
        key,
        drop: () => finish(false),
        run: () => {
          void this.capture(url, PICTURE_BYTES_PX)
            .catch(() => null)
            .then(async (data) => {
              this.active -= 1;
              this.pump();
              if (!current()) return finish(false);
              if (!isPictureData(data)) {
                // Offline by now: not known yet, rather than a failure to remember.
                if (this.isOnline()) this.failedAt.set(key, this.now());
                return finish(false);
              }
              const now = this.now();
              await this.store({ key, kind, data, savedAt: now, usedAt: now });
              finish(true);
            });
        },
      });
      // Rows long scrolled past: dropped unanswered, so one that comes back asks again.
      while (this.queue.length > MAX_QUEUED_CAPTURES) this.queue.pop()?.drop();
      this.pump();
    });
  }

  /** Drop every copy of one kind: its switch went off (or the contacts grant did). */
  async clearKind(kind: PictureKind): Promise<void> {
    this.kindGeneration[kind] += 1;
    let changed = false;
    for (const [key, record] of this.records) {
      if (record.kind !== kind) continue;
      this.records.delete(key);
      changed = true;
    }
    if (changed) this.emit();
    // Storage is cleared whether or not memory held any: the warm may not have landed.
    await this.storage.removeKind(kind).catch(() => undefined);
  }

  /** Forget everything, storage included: sign-out. Captures still running are ignored. */
  async clear(): Promise<void> {
    this.generation += 1;
    this.records = new Map();
    this.failedAt.clear();
    // Queued captures never start; their callers get `false` rather than a promise that
    // never settles.
    for (const entry of this.queue.splice(0)) entry.drop();
    this.inflight.clear();
    this.emit();
    await this.storage.clear().catch(() => undefined);
  }

  /** Copies kept, most recently used first. For tests and diagnostics. */
  keys(): string[] {
    return [...this.records.values()].sort((a, b) => b.usedAt - a.usedAt).map((record) => record.key);
  }

  private async warm(): Promise<void> {
    const generation = this.generation;
    const kindGenerations = { ...this.kindGeneration };
    let raw: unknown;
    try {
      raw = await this.storage.readAll();
    } catch {
      return;
    }
    if (generation !== this.generation) return;
    const now = this.now();
    const kept = sanitisePictures(raw, now)
      // A kind cleared while the read was running stays cleared.
      .filter((record) => kindGenerations[record.kind] === this.kindGeneration[record.kind])
      .sort((a, b) => b.usedAt - a.usedAt);
    const keep = kept.slice(0, this.maxEntries);
    const keepKeys = new Set(keep.map((record) => record.key));
    // A capture that landed while the read was running is newer than what was read.
    for (const record of keep) if (!this.records.has(record.key)) this.records.set(record.key, record);
    const stored = Array.isArray(raw) ? (raw as { key?: unknown }[]).map((item) => item?.key) : [];
    const drop = stored.filter((key): key is string => typeof key === "string" && !keepKeys.has(key) && !this.records.has(key));
    drop.push(...this.evict());
    this.emit();
    if (drop.length > 0) await this.storage.remove(drop).catch(() => undefined);
  }

  private async store(record: StoredPicture): Promise<void> {
    this.failedAt.delete(record.key);
    this.records.set(record.key, record);
    const evicted = this.evict();
    this.emit();
    await this.storage.put(record).catch(() => undefined);
    if (evicted.length > 0) await this.storage.remove(evicted).catch(() => undefined);
  }

  /** Drop the least recently used beyond `maxEntries`; the keys dropped. */
  private evict(): string[] {
    if (this.records.size <= this.maxEntries) return [];
    const gone = [...this.records.values()]
      .sort((a, b) => a.usedAt - b.usedAt || a.savedAt - b.savedAt)
      .slice(0, this.records.size - this.maxEntries)
      .map((record) => record.key);
    for (const key of gone) this.records.delete(key);
    return gone;
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  private pump(): void {
    while (this.queue.length > 0 && this.active < this.concurrency) {
      const next = this.queue.shift();
      if (!next) return;
      this.active += 1;
      next.run();
    }
  }
}

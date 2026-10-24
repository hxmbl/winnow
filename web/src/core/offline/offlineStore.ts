/**
 * The durable offline store: one IndexedDB database per account.
 *
 * Why this exists. The mailbox used to be persisted as one JSON string in one
 * `localStorage` key. `localStorage` is capped per origin at roughly 5 MB (about 5
 * million UTF-16 characters in Chromium, the Android WebView included) and that cap is
 * not raised by `navigator.storage.persist()` — persistence only protects storage from
 * eviction. So the "large mailbox" prompt's Save asked for persistence and wrote the
 * same oversize string to the same key again, which threw again; and even a mailbox
 * that fitted held only metadata plus the bodies someone happened to open. Nothing was
 * ever downloaded for offline use, and attachments were never stored at all.
 *
 * IndexedDB is the browser's store for this size of data: its quota is a share of the
 * disk (Chromium: up to 60% of it per origin), values are structured clones (bytes are
 * stored as bytes, not base64 strings), and on the desktop and Android builds the
 * WebView keeps it in the app's own data directory, like `localStorage` before it.
 *
 * Layout of `winnow-offline@<account>` (version 1):
 *
 *   - `mailbox` — one record, key `"messages"`: the cache mirror's JSON, the same
 *     string that used to go to `localStorage` (`session.ts`, `localCache`).
 *   - `bodies`  — keyPath `gmailId`: a message's whole body (`StoredBody`).
 *   - `index`   — keyPath `gmailId`: `{ gmailId, bytes }`, so counting what is saved
 *     and how big it is never reads a body.
 *   - `files`   — keyPath `[gmailId, attachmentId]`, index `gmailId`: attachment bytes.
 *
 * A database per account makes the privacy rule one call: signing out of an account
 * deletes its database (`clear`), and no account can read another's.
 */

import type { Attachment, BodySource, LoadedBody } from "../model/email";
import { committed, deleteDatabase, done, lazyConnection, type IdbFactory } from "./idb";

/** A message's whole body, as kept offline. */
export type StoredBody = {
  gmailId: string;
  body: string;
  bodySource?: BodySource;
  bodyHtml?: string;
  attachments: Attachment[];
  /** Attachment ids whose bytes are in `files`. */
  files: string[];
  /** Attachments left on demand: over `ATTACHMENT_DOWNLOAD_CAP`, or with no id. */
  skipped: number;
  /** Approximate bytes on disk: body text, HTML and saved files. */
  bytes: number;
  savedAt: number;
};

export type SavedFile = { attachmentId: string; bytes: Uint8Array };

export type OfflineStats = { messages: number; bytes: number };

export interface OfflineStore {
  /** The cache mirror's JSON, or `null` when none was ever written. */
  readMailbox(): Promise<string | null>;
  writeMailbox(json: string): Promise<void>;
  getBody(gmailId: string): Promise<StoredBody | null>;
  /** One message's body and its files, in one transaction: both land or neither does. */
  putBody(body: StoredBody, files: readonly SavedFile[]): Promise<void>;
  getFile(gmailId: string, attachmentId: string): Promise<Uint8Array | null>;
  savedIds(): Promise<Set<string>>;
  stats(): Promise<OfflineStats>;
  /** Forget bodies and files of these messages (gone on the server). */
  remove(gmailIds: readonly string[]): Promise<void>;
  /** Forget bodies and files of every message not listed; returns how many went. */
  keepOnly(gmailIds: readonly string[]): Promise<number>;
  /** "Remove downloads": bodies and files go, the mailbox mirror stays. */
  clearDownloads(): Promise<void>;
  /** Everything, the mailbox included: sign-out. */
  clear(): Promise<void>;
}

/** The database an account's offline copy lives in. `undefined`: the device's own (tests, demo). */
export function offlineDbName(account?: string): string {
  return account ? `winnow-offline@${account}` : "winnow-offline";
}

/** Rough on-disk size of a body: UTF-16 text is two bytes a character. */
export function bodyBytes(body: Pick<LoadedBody, "body" | "bodyHtml">, files: readonly SavedFile[] = []): number {
  return (body.body.length + (body.bodyHtml?.length ?? 0)) * 2 + files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
}

/** The body a stored record gives back to the reader. */
export function loadedFromStored(stored: StoredBody): LoadedBody {
  return {
    body: stored.body,
    ...(stored.bodySource ? { bodySource: stored.bodySource } : {}),
    ...(stored.bodyHtml !== undefined ? { bodyHtml: stored.bodyHtml } : {}),
    attachments: stored.attachments,
  };
}

/** An in-memory store with the same behaviour: tests, and hosts without IndexedDB. */
export function memoryOfflineStore(): OfflineStore & { readonly files: Map<string, Uint8Array> } {
  let mailbox: string | null = null;
  const bodies = new Map<string, StoredBody>();
  const files = new Map<string, Uint8Array>();
  const fileKey = (gmailId: string, attachmentId: string) => `${gmailId}\u0000${attachmentId}`;
  const dropFiles = (gmailId: string) => {
    for (const key of [...files.keys()]) if (key.startsWith(`${gmailId}\u0000`)) files.delete(key);
  };
  return {
    files,
    async readMailbox() {
      return mailbox;
    },
    async writeMailbox(json) {
      mailbox = json;
    },
    async getBody(gmailId) {
      return bodies.get(gmailId) ?? null;
    },
    async putBody(body, saved) {
      dropFiles(body.gmailId);
      bodies.set(body.gmailId, body);
      for (const file of saved) files.set(fileKey(body.gmailId, file.attachmentId), file.bytes);
    },
    async getFile(gmailId, attachmentId) {
      return files.get(fileKey(gmailId, attachmentId)) ?? null;
    },
    async savedIds() {
      return new Set(bodies.keys());
    },
    async stats() {
      let bytes = 0;
      for (const body of bodies.values()) bytes += body.bytes;
      return { messages: bodies.size, bytes };
    },
    async remove(gmailIds) {
      for (const id of gmailIds) {
        bodies.delete(id);
        dropFiles(id);
      }
    },
    async keepOnly(gmailIds) {
      const keep = new Set(gmailIds);
      let removed = 0;
      for (const id of [...bodies.keys()]) {
        if (keep.has(id)) continue;
        bodies.delete(id);
        dropFiles(id);
        removed += 1;
      }
      return removed;
    },
    async clearDownloads() {
      bodies.clear();
      files.clear();
    },
    async clear() {
      mailbox = null;
      bodies.clear();
      files.clear();
    },
  };
}

const MAILBOX_KEY = "messages";

/**
 * The IndexedDB store. The connection is opened on first use and dropped by `clear`
 * (a database cannot be deleted while this page holds it open).
 */
export function indexedDbOfflineStore(name: string, idb: IdbFactory | undefined = globalThis.indexedDB): OfflineStore {
  const connection = lazyConnection(
    name,
    1,
    (database) => {
      if (!database.objectStoreNames.contains("mailbox")) database.createObjectStore("mailbox");
      if (!database.objectStoreNames.contains("bodies")) database.createObjectStore("bodies", { keyPath: "gmailId" });
      if (!database.objectStoreNames.contains("index")) database.createObjectStore("index", { keyPath: "gmailId" });
      if (!database.objectStoreNames.contains("files")) {
        const files = database.createObjectStore("files", { keyPath: ["gmailId", "attachmentId"] });
        files.createIndex("gmailId", "gmailId");
      }
    },
    idb,
    "the offline store",
  );
  const open = (): Promise<IDBDatabase> => connection.open();

  /** Delete one message's files inside an open transaction. */
  const deleteFiles = (tx: IDBTransaction, gmailId: string): void => {
    const index = tx.objectStore("files").index("gmailId");
    const request = index.openKeyCursor(gmailId);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      tx.objectStore("files").delete(cursor.primaryKey);
      cursor.continue();
    };
  };

  const removeIds = async (ids: readonly string[]): Promise<void> => {
    if (ids.length === 0) return;
    const database = await open();
    const tx = database.transaction(["bodies", "index", "files"], "readwrite");
    for (const id of ids) {
      tx.objectStore("bodies").delete(id);
      tx.objectStore("index").delete(id);
      deleteFiles(tx, id);
    }
    await committed(tx);
  };

  const savedIds = async (): Promise<Set<string>> => {
    const database = await open();
    const keys = await done(database.transaction("index").objectStore("index").getAllKeys());
    return new Set(keys.map(String));
  };

  return {
    async readMailbox() {
      const database = await open();
      const value = await done(database.transaction("mailbox").objectStore("mailbox").get(MAILBOX_KEY));
      return typeof value === "string" ? value : null;
    },
    async writeMailbox(json) {
      const database = await open();
      const tx = database.transaction("mailbox", "readwrite");
      tx.objectStore("mailbox").put(json, MAILBOX_KEY);
      await committed(tx);
    },
    async getBody(gmailId) {
      const database = await open();
      const value = await done(database.transaction("bodies").objectStore("bodies").get(gmailId));
      return (value as StoredBody | undefined) ?? null;
    },
    async putBody(body, files) {
      const database = await open();
      const tx = database.transaction(["bodies", "index", "files"], "readwrite");
      deleteFiles(tx, body.gmailId);
      tx.objectStore("bodies").put(body);
      tx.objectStore("index").put({ gmailId: body.gmailId, bytes: body.bytes });
      for (const file of files) {
        tx.objectStore("files").put({ gmailId: body.gmailId, attachmentId: file.attachmentId, bytes: file.bytes });
      }
      await committed(tx);
    },
    async getFile(gmailId, attachmentId) {
      const database = await open();
      const value = await done(database.transaction("files").objectStore("files").get([gmailId, attachmentId]));
      const bytes = (value as { bytes?: Uint8Array } | undefined)?.bytes;
      return bytes ? new Uint8Array(bytes) : null;
    },
    savedIds,
    async stats() {
      const database = await open();
      const rows = (await done(database.transaction("index").objectStore("index").getAll())) as { bytes?: number }[];
      return { messages: rows.length, bytes: rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0) };
    },
    remove: removeIds,
    async keepOnly(gmailIds) {
      const keep = new Set(gmailIds);
      const gone = [...(await savedIds())].filter((id) => !keep.has(id));
      await removeIds(gone);
      return gone.length;
    },
    async clearDownloads() {
      const database = await open();
      const tx = database.transaction(["bodies", "index", "files"], "readwrite");
      tx.objectStore("bodies").clear();
      tx.objectStore("index").clear();
      tx.objectStore("files").clear();
      await committed(tx);
    },
    async clear() {
      if (!idb) return;
      // A database cannot be deleted while this page holds it open (`deleteDatabase`).
      await connection.close();
      await deleteDatabase(idb, name, "the offline store");
    },
  };
}

/** The store for an account on this host: IndexedDB when there is one, otherwise none. */
export function defaultOfflineStore(account?: string): OfflineStore | null {
  if (typeof globalThis.indexedDB === "undefined") return null;
  return indexedDbOfflineStore(offlineDbName(account));
}

/**
 * The store with its writes dropped while `open()` says no: the same rule as the session's
 * `gatedCache`. A download on the wire when the account signs out must not put a body back
 * into the database the sign-out just deleted (opening it again would re-create it).
 */
export function gatedOfflineStore(store: OfflineStore, open: () => boolean): OfflineStore {
  return {
    ...store,
    readMailbox: () => store.readMailbox(),
    getBody: (gmailId) => store.getBody(gmailId),
    getFile: (gmailId, attachmentId) => store.getFile(gmailId, attachmentId),
    savedIds: () => store.savedIds(),
    stats: () => store.stats(),
    remove: (ids) => store.remove(ids),
    keepOnly: (ids) => store.keepOnly(ids),
    clearDownloads: () => store.clearDownloads(),
    clear: () => store.clear(),
    writeMailbox: async (json) => {
      if (open()) await store.writeMailbox(json);
    },
    putBody: async (body, files) => {
      if (open()) await store.putBody(body, files);
    },
  };
}

/**
 * Delete an account's offline database outright: the bridge's backstop when an account
 * is removed, whatever the session's own sign-out managed. Never throws.
 */
export async function deleteOfflineData(account: string, idb: IdbFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (!idb) return;
  await indexedDbOfflineStore(offlineDbName(account), idb).clear().catch(() => undefined);
}

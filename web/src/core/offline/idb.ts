/**
 * The few IndexedDB helpers every on-device database in the app shares: the offline
 * mailbox (`offlineStore.ts`) and the sender-picture bytes (`avatars/pictureBytes.ts`).
 *
 * IndexedDB's API is events on request objects; these turn the parts the app uses into
 * promises, and keep the two rules that matter for a database that belongs to one
 * account in one place:
 *
 *   - **Another tab's sign-out wins.** A connection closes itself on `versionchange`
 *     (another page deleting the database) rather than blocking the delete, and the
 *     next use opens a fresh one.
 *   - **A sign-out never hangs.** Deleting a database another page still holds open
 *     resolves after `CLEAR_BLOCKED_MS`, leaving the delete queued: the browser runs it
 *     as soon as the last connection closes.
 */

export type IdbFactory = Pick<IDBFactory, "open" | "deleteDatabase">;

/** How long a sign-out waits on a database another page still holds open. */
export const CLEAR_BLOCKED_MS = 3000;

/** Promise over one request. */
export function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Promise over a whole transaction: resolves once it has committed. */
export function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

/**
 * A connection opened on first use and kept: `open()` answers the same database until
 * `close()` (or another page's delete) drops it. `upgrade` creates the object stores;
 * `label` names the database in errors ("the offline store").
 */
export function lazyConnection(
  name: string,
  version: number,
  upgrade: (database: IDBDatabase) => void,
  idb: IdbFactory | undefined,
  label = "the database",
): { open(): Promise<IDBDatabase>; close(): Promise<void> } {
  let db: Promise<IDBDatabase> | null = null;
  return {
    open() {
      if (!idb) return Promise.reject(new Error("IndexedDB is not available"));
      db ??= new Promise<IDBDatabase>((resolve, reject) => {
        const request = idb.open(name, version);
        request.onupgradeneeded = () => upgrade(request.result);
        request.onsuccess = () => {
          const database = request.result;
          // Another tab deleting this database (its sign-out) closes ours instead of blocking it.
          database.onversionchange = () => {
            database.close();
            db = null;
          };
          resolve(database);
        };
        request.onerror = () => reject(request.error ?? new Error(`could not open ${label}`));
        request.onblocked = () => reject(new Error(`${label} is open elsewhere`));
      }).catch((error: unknown) => {
        db = null;
        throw error;
      });
      return db;
    },
    async close() {
      const pending = db;
      db = null;
      if (pending) (await pending.catch(() => null))?.close();
    },
  };
}

/**
 * Delete a database outright. A database cannot be deleted while a connection is open,
 * so the caller closes its own first (`lazyConnection().close()`); another page's closes
 * on `versionchange`, and one that never lets go is waited on for `CLEAR_BLOCKED_MS` at
 * most (see the file comment).
 */
export function deleteDatabase(idb: IdbFactory, name: string, label = "the database"): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = idb.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`could not delete ${label}`));
    request.onblocked = () => {
      setTimeout(resolve, CLEAR_BLOCKED_MS);
    };
  });
}

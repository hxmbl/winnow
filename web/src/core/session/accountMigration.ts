/**
 * The move from 1.3.5's single, unscoped account to 1.4.0's namespaces.
 *
 * Runs once, at launch, before anything reads an account's data: when there is no
 * registry yet (`winnow.accounts.v1`) and the old token store still holds a session, the
 * existing account gets an id, each of its keys is copied to `<key>@<id>`, its tokens are
 * written to the account's own token entry (the keychain on desktop and Android, under the
 * same service), the registry is written naming it active, and only then are the old
 * copies deleted, the retired-keys way (`retiredKeys.ts`): each removal guarded on its
 * own, and a launch never fails over housekeeping. Nobody signs in again.
 *
 * Storage: a mail cache too big to copy within the quota is dropped (with its cursor)
 * rather than deferring the migration for ever; it is a copy of Gmail, and the first
 * sync rebuilds it in full.
 *
 * Crash safety: the id is recorded first (`winnow.accounts.migration`, read back; a
 * refused write defers), so a migration cut short re-runs into the same namespace
 * instead of leaving a copy of the mail under an id nobody owns; and the old copies go
 * last, only once the account's tokens and the registry are both confirmed in storage
 * (written and read back, `persistAccounts`). A write that fails defers: nothing old is
 * deleted, the legacy session is intact, and the next launch tries again.
 *
 * With no session (signed out under 1.3.5), there is no account to move: an empty
 * registry is written, the old mail-shaped keys (empty after a sign-out anyway) are
 * deleted, and what Winnow learned stays where it was, as this device's learning — the
 * demo's, and the first account added adopts it (`adoptDeviceLearning`).
 */

import type { TokenStore } from "../gmail/tokens";
import {
  ACCOUNT_SCOPED_KEYS,
  accountKey,
  hasAccountsRecord,
  isAccountId,
  newAccountId,
  nextColor,
  persistAccounts,
  type AccountRecord,
  type KeyValueStorage,
} from "./accounts";

export const MIGRATION_ID_KEY = "winnow.accounts.migration";

const MESSAGES_KEY = "winnow.gmail.cache.messages";
const CURSOR_KEY = "winnow.gmail.cache.cursor";

/** Keys that are about the device rather than an account once nothing is signed in. */
const DEVICE_KEYS = new Set<string>([
  "winnow.learning.v1",
  "winnow.filterLearning.v1",
  "winnow.activeFilters.v1",
  "winnow.mailbox.v1",
]);

export type MigrationOutcome =
  | { kind: "none" }
  | { kind: "migrated"; account: AccountRecord }
  | { kind: "signed-out" }
  | { kind: "deferred"; reason: string };

export type MigrationOptions = {
  storage: KeyValueStorage | null;
  /** 1.3.5's token store: `winnow.gmail.tokens`, or the keychain's `gmail.tokens`. */
  legacyTokens: TokenStore;
  /** The account's own token store. */
  tokensFor: (id: string) => TokenStore;
  newId?: () => string;
  now?: () => number;
};

function guarded<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

/** The address the 1.3.5 data names, when it names one: the learning's owner, the queue's account. */
export function legacyAddressHint(storage: KeyValueStorage | null): string {
  const read = (key: string): unknown => guarded(() => JSON.parse(storage?.getItem(key) ?? "null"), null);
  const learning = read("winnow.filterLearning.v1") as { owner?: unknown } | null;
  if (typeof learning?.owner === "string" && learning.owner.includes("@")) return learning.owner;
  const queue = read("winnow.offlineQueue.v1") as { account?: unknown } | null;
  if (typeof queue?.account === "string" && queue.account.includes("@")) return queue.account;
  return "";
}

export async function migrateToAccounts(options: MigrationOptions): Promise<MigrationOutcome> {
  const { storage, legacyTokens, tokensFor } = options;
  if (!storage || hasAccountsRecord(storage)) return { kind: "none" };

  let tokens;
  try {
    tokens = await legacyTokens.read();
  } catch (error) {
    // A locked keychain: nothing is moved or deleted, and the next launch tries again.
    return { kind: "deferred", reason: error instanceof Error ? error.message : String(error) };
  }

  if (!tokens) {
    // The empty registry is what says the migration happened: unwritten, nothing goes,
    // and the next launch runs this again.
    if (!persistAccounts(storage, { version: 1, active: null, accounts: [] })) {
      return { kind: "deferred", reason: "the account registry could not be saved" };
    }
    for (const key of ACCOUNT_SCOPED_KEYS) {
      if (DEVICE_KEYS.has(key)) continue;
      guarded(() => storage.removeItem(key), undefined);
    }
    return { kind: "signed-out" };
  }

  const recorded = guarded(() => storage.getItem(MIGRATION_ID_KEY), null);
  const id = isAccountId(recorded) ? recorded : (options.newId ?? newAccountId)();
  // Unrecorded, a retry would mint another id and leave these copies under one nobody owns.
  const idRecorded = guarded(() => {
    storage.setItem(MIGRATION_ID_KEY, id);
    return storage.getItem(MIGRATION_ID_KEY) === id;
  }, false);
  if (!idRecorded) return { kind: "deferred", reason: "the migration could not record its account id" };

  let mailDropped = false;
  for (const key of ACCOUNT_SCOPED_KEYS) {
    // The cursor only means anything over the mail it was recorded with.
    if (mailDropped && key === CURSOR_KEY) continue;
    const value = guarded(() => storage.getItem(key), null);
    if (value === null) continue;
    try {
      storage.setItem(accountKey(key, id), value);
    } catch (error) {
      if (key === MESSAGES_KEY) {
        // Copy-then-delete needs the mail cache twice over, and a big 1.3.5 mailbox is
        // already near the origin's quota: deferring here would defer on every launch,
        // leaving the user signed out for good. The cache is a copy of Gmail, so it goes
        // instead (with its cursor), freeing the room the rest needs, and the first sync
        // is a full one.
        mailDropped = true;
        guarded(() => storage.removeItem(accountKey(MESSAGES_KEY, id)), undefined);
        guarded(() => storage.removeItem(accountKey(CURSOR_KEY, id)), undefined);
        guarded(() => storage.removeItem(MESSAGES_KEY), undefined);
        guarded(() => storage.removeItem(CURSOR_KEY), undefined);
        continue;
      }
      return { kind: "deferred", reason: error instanceof Error ? error.message : "storage is full" };
    }
  }
  try {
    const store = tokensFor(id);
    await store.write(tokens);
    // Read back: the legacy tokens are deleted on the strength of this copy.
    const copied = await store.read();
    if (copied?.refreshToken !== tokens.refreshToken || copied?.accessToken !== tokens.accessToken) {
      return { kind: "deferred", reason: "the account's tokens did not save" };
    }
  } catch (error) {
    return { kind: "deferred", reason: error instanceof Error ? error.message : String(error) };
  }

  const account: AccountRecord = {
    id,
    email: legacyAddressHint(storage),
    color: nextColor([]),
    notify: true,
    addedAt: (options.now ?? Date.now)(),
  };
  // The registry is what names the owner of the `<key>@<id>` copies. Until it is in
  // storage (written and read back), nothing old is deleted: the legacy session still
  // signs in, and the next launch runs this again into the same id.
  if (!persistAccounts(storage, { version: 1, active: id, accounts: [account] })) {
    return { kind: "deferred", reason: "the account registry could not be saved" };
  }

  for (const key of ACCOUNT_SCOPED_KEYS) guarded(() => storage.removeItem(key), undefined);
  await legacyTokens.clear().catch(() => undefined);
  guarded(() => storage.removeItem(MIGRATION_ID_KEY), undefined);
  return { kind: "migrated", account };
}

/**
 * The first account added adopts what this device learned with no account (the demo, or
 * a 1.3.5 install that was signed out): moved, not copied, so it belongs to one account.
 * An account that already has its own learning keeps it.
 */
export function adoptDeviceLearning(storage: KeyValueStorage | null, id: string): void {
  if (!storage) return;
  for (const key of ["winnow.learning.v1"]) {
    const device = guarded(() => storage.getItem(key), null);
    if (device === null) continue;
    if (guarded(() => storage.getItem(accountKey(key, id)), null) !== null) continue;
    // Moved only once the account's copy is really there: a refused write keeps the device's.
    const moved = guarded(() => {
      storage.setItem(accountKey(key, id), device);
      return storage.getItem(accountKey(key, id)) === device;
    }, false);
    if (moved) guarded(() => storage.removeItem(key), undefined);
  }
}

/**
 * What the store keeps per account (1.4.0), as storage holds it: the sorting weights,
 * the smart-filter corrections, the active filters and the last mailbox. Read when an
 * account opens (`WinnowStore.enterAccount`), written by `main.tsx`'s `persist` under the
 * open account's namespace, and erased with the account.
 *
 * `null` as the id is the device itself: the demo, and anything learned with no account
 * signed in, under the unscoped keys 1.3.5 used.
 */

import { ACCOUNT_SCOPED_KEYS, accountKey, type AccountScopedKey, type KeyValueStorage } from "../session/accounts";
import type { AccountState, PersistPatch } from "./store";
import { parseFilterKey, filterKey } from "../model/signals";
import { isMailboxOrView } from "../model/email";
import type { LearningSnapshot } from "../learn/learning";
import { LocalDrafts } from "../mail/drafts";
import { readJson, writeJson } from "./storage";

export const ACCOUNT_STATE_KEYS = {
  learning: "winnow.learning.v1",
  filterLearning: "winnow.filterLearning.v1",
  filters: "winnow.activeFilters.v1",
  mailbox: "winnow.mailbox.v1",
} as const satisfies Record<string, AccountScopedKey>;

/** `key` for the device, `key@id` for an account. */
export function keyFor(key: string, id: string | null): string {
  return id === null ? key : accountKey(key, id);
}

export function loadAccountState(storage: KeyValueStorage | null, id: string | null): AccountState {
  const filters = readJson(storage, keyFor(ACCOUNT_STATE_KEYS.filters, id));
  const mailbox = readJson(storage, keyFor(ACCOUNT_STATE_KEYS.mailbox, id));
  return {
    learning: (readJson(storage, keyFor(ACCOUNT_STATE_KEYS.learning, id)) as LearningSnapshot | null) ?? null,
    filterLearning: readJson(storage, keyFor(ACCOUNT_STATE_KEYS.filterLearning, id)),
    activeFilters: Array.isArray(filters)
      ? filters
          .map((key) => (typeof key === "string" ? parseFilterKey(key) : null))
          .filter((filter): filter is NonNullable<typeof filter> => filter !== null)
          .map(filterKey)
      : [],
    mailbox: isMailboxOrView(mailbox) ? mailbox : null,
  };
}

/** Write the account-scoped half of a persist patch (preferences are the caller's: shared). */
export function persistAccountState(storage: KeyValueStorage | null, id: string | null, patch: PersistPatch): void {
  if (patch.learning) writeJson(storage, keyFor(ACCOUNT_STATE_KEYS.learning, id), patch.learning);
  if (patch.filterLearning) writeJson(storage, keyFor(ACCOUNT_STATE_KEYS.filterLearning, id), patch.filterLearning);
  if (patch.activeFilters) writeJson(storage, keyFor(ACCOUNT_STATE_KEYS.filters, id), patch.activeFilters);
  if (patch.mailbox) writeJson(storage, keyFor(ACCOUNT_STATE_KEYS.mailbox, id), patch.mailbox);
}

/**
 * Erase everything one account stored on this device: every scoped key under its
 * namespace, and its device copies of drafts (named by its address). Nothing of any
 * other account, and nothing shared, is touched. The tokens are the token store's
 * (the session's `signOut`), not this.
 */
export function wipeAccountStorage(storage: KeyValueStorage | null, id: string, email: string): void {
  if (!storage) return;
  for (const key of ACCOUNT_SCOPED_KEYS) {
    try {
      storage.removeItem(accountKey(key, id));
    } catch {
      // Unreachable storage holds nothing anyone can read through this app.
    }
  }
  if (email) new LocalDrafts(storage, email).clear();
}

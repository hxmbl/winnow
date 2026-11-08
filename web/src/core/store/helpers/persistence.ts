/**
 * Small persistence helpers shared by the store's features.
 *
 * The records themselves (snoozes, schedules, account state) are parsed and merged by
 * their own modules; this is only the glue that turns a saved key list back into the
 * state shape the store holds.
 */

import type { FilterId } from "../../model/signals";
import { parseFilterKey } from "../../model/signals";
import type { Preferences } from "../state";

/** Restore the active filters from their persisted keys, dropping anything unknown. */
export function restoreFilters(saved: readonly string[] | undefined): FilterId[] {
  return (saved ?? []).map(parseFilterKey).filter((filter): filter is FilterId => filter !== null);
}

/** Preferences are a person's, not an account's: a saved patch layers over the current set. */
export function mergePreferences(current: Preferences, patch: Partial<Preferences> | undefined): Preferences {
  return { ...current, ...(patch ?? {}) };
}

/**
 * Storage keys earlier builds wrote and this one no longer reads.
 *
 * `winnow.mutedFilters.v1` held the buckets the user had hidden from the rail. Hiding a
 * bucket is gone, so every bucket is back on the rail and in the inbox; the key is
 * deleted on launch so a stale list cannot linger in storage, and nothing reads it.
 */
export const RETIRED_STORAGE_KEYS = ["winnow.mutedFilters.v1"] as const;

/**
 * Delete the retired keys.
 *
 * Takes a resolver rather than the storage itself because merely touching
 * `localStorage` throws in some private-mode browsers, and a launch must never fail
 * over housekeeping. Each removal is guarded on its own for the same reason.
 */
export function dropRetiredKeys(
  resolve: () => Pick<Storage, "removeItem"> | null | undefined,
): void {
  let storage: Pick<Storage, "removeItem"> | null | undefined;
  try {
    storage = resolve();
  } catch {
    return;
  }
  if (!storage) return;
  for (const key of RETIRED_STORAGE_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Nothing to do: the key is ignored either way.
    }
  }
}

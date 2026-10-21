/**
 * Merging a window's list of device records (snoozes, scheduled sends) with what another
 * window of the app wrote to the same storage key since this one last read it (STRM-290).
 *
 * Every window keeps the list in memory and writes the whole of it back, so without a
 * merge the last window to save wins and the other window's new entries are lost. This is
 * a three-way merge, by record key, of:
 *
 *   - `base`:   the list as this window last read or wrote it,
 *   - `mine`:   the list this window wants to write now,
 *   - `theirs`: the list storage holds right now (another window may have changed it).
 *
 * The rules, per key:
 *   - added by me (in `mine`, not in `base`): kept, mine;
 *   - added by them (in `theirs`, not in `base`, not mine): kept, theirs;
 *   - changed by me (in both, different from `base`): mine, unless they removed it;
 *   - removed by either side: gone. A removal wins over a change on the other side, so a
 *     schedule another window has sent or cancelled is never brought back to send twice,
 *     and a snooze another window has woken never goes back to sleep;
 *   - untouched by me: whatever `theirs` says.
 *
 * Pure.
 */

export type MergeOptions<T> = {
  /** A record's identity. */
  keyOf: (record: T) => string;
  /** What is compared to tell a changed record from an untouched one (as stored). */
  fingerprint?: (record: T) => string;
};

export function mergeRecords<T>(
  base: readonly T[],
  mine: readonly T[],
  theirs: readonly T[],
  { keyOf, fingerprint = (record) => JSON.stringify(record) }: MergeOptions<T>,
): T[] {
  const baseBy = new Map<string, string>();
  for (const record of base) baseBy.set(keyOf(record), fingerprint(record));
  const mineBy = new Map<string, T>();
  for (const record of mine) mineBy.set(keyOf(record), record);

  const out = new Map<string, T>();
  for (const record of theirs) {
    const key = keyOf(record);
    const inBase = baseBy.has(key);
    const own = mineBy.get(key);
    // Removed by me.
    if (inBase && own === undefined) continue;
    // Added or changed by me (they still have it): mine.
    if (own !== undefined && (!inBase || fingerprint(own) !== baseBy.get(key))) {
      out.set(key, own);
      continue;
    }
    // Untouched by me, or added by them.
    out.set(key, record);
  }
  for (const [key, own] of mineBy) {
    if (out.has(key)) continue;
    // Not in storage now: added by me since the last read (kept), or removed by them (gone,
    // even if I changed it meanwhile).
    if (!baseBy.has(key)) out.set(key, own);
  }
  return [...out.values()];
}

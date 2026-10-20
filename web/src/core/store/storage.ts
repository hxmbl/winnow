/**
 * The device storage the store reads and writes, guarded in one place.
 *
 * Every caller used to spell out the same two rules: touching `globalThis.localStorage`
 * can throw on the getter itself (a sandboxed iframe, private mode), and a corrupt or
 * absent value is not an error — it means "nothing was stored". Keeping both here means
 * the preferences, account state and feature slots cannot disagree about what a failed
 * read is.
 */

/** `globalThis.localStorage`, or `null` where even reading the getter throws. */
export function deviceStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored JSON at `key`, or `null` when it is absent, unparseable or unreadable. */
export function readJson(storage: Pick<Storage, "getItem"> | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/**
 * Store `value` as JSON.
 *
 * A full quota or a storage-disabled host throws here. That is deliberately swallowed:
 * the run keeps the value in memory, and only the *next* launch loses it.
 */
export function writeJson(storage: Pick<Storage, "setItem"> | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // See above: the failure is a next-launch problem, not this run's.
  }
}

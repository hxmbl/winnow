/** The dropdown's list movement (`components/SelectMenu.tsx`), pure for the tests. */

/**
 * The next enabled index from `from` in `step` direction (±1), wrapping. `from` may be
 * -1 or `length` to start from an end. Returns `from` clamped when nothing is enabled.
 */
export function nextEnabled(enabled: readonly boolean[], from: number, step: 1 | -1): number {
  const n = enabled.length;
  if (n === 0) return 0;
  for (let i = 1; i <= n; i += 1) {
    const index = (((from + step * i) % n) + n) % n;
    if (enabled[index]) return index;
  }
  return Math.min(Math.max(from, 0), n - 1);
}

/**
 * A printable key jumps to the next enabled option (after `active`, wrapping) whose label
 * starts with it, case-insensitively; null for any other key or no match.
 */
export function typeAhead(labels: readonly string[], enabled: readonly boolean[], active: number, key: string): number | null {
  if (key.length !== 1 || !/\S/.test(key)) return null;
  const letter = key.toLocaleLowerCase();
  const n = labels.length;
  for (let i = 1; i <= n; i += 1) {
    const index = (active + i) % n;
    if (enabled[index] && labels[index].toLocaleLowerCase().startsWith(letter)) return index;
  }
  return null;
}

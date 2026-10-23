/**
 * Settings → Dev Options: switches for looking under the hood, kept apart from the
 * shared preferences.
 *
 * **Hidden until unlocked.** The category is not listed until About's version has been
 * tapped ten times (`devUnlockTap`, Android's "build number" gesture); from the seventh
 * tap a countdown says how many are left. "Hide Dev Options" at the bottom of the
 * category locks it again and turns every switch in it off. Deliberately not in the
 * README or the user docs.
 *
 * Stored on this device only, under `winnow.devOptions.v1` as
 * `{ version: 1, unlocked, ...switches }` (`DEV_SWITCHES`). Not per account (nothing here is about an
 * account), never synced, and not cleared by sign-out. Everything is off by default,
 * and all-off is saved as *no entry*, so hiding Dev Options leaves nothing behind.
 */

export const DEV_OPTIONS_KEY = "winnow.devOptions.v1";

export type DevOptions = {
  /** Dev Options has been unlocked from About's version; the category is listed. */
  unlocked: boolean;
  /**
   * Pure Plain Text: the reader's Plain text form shows the message's `text/plain`
   * part exactly as sent, with none of the usual tidying (`core/mail/plainView.ts`).
   */
  purePlainText: boolean;
  /** View Original: the reader's ⋯ menu offers the message's raw source (`core/mail/rawSource.ts`). */
  viewOriginal: boolean;
};

export const DEFAULT_DEV_OPTIONS: DevOptions = { unlocked: false, purePlainText: false, viewOriginal: false };

/** The switches inside Dev Options (everything but `unlocked`), which hiding turns off. */
export const DEV_SWITCHES = ["purePlainText", "viewOriginal"] as const satisfies ReadonlyArray<Exclude<keyof DevOptions, "unlocked">>;

/** The subset of `Storage` this needs, so a test can hand in a map. */
export interface DevOptionsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `localStorage`, or null where it is missing or refused. */
export function devOptionsStorage(): DevOptionsStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The saved options, or the defaults. Tolerant, because the input is `localStorage`:
 * only a literal `true` turns anything on, and no switch is on while Dev Options is
 * locked.
 */
export function loadDevOptions(storage: DevOptionsStorage | null | undefined = devOptionsStorage()): DevOptions {
  try {
    const raw = storage?.getItem(DEV_OPTIONS_KEY);
    if (raw == null) return { ...DEFAULT_DEV_OPTIONS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_DEV_OPTIONS };
    const record = parsed as Record<string, unknown>;
    if (record.unlocked !== true) return { ...DEFAULT_DEV_OPTIONS };
    const options: DevOptions = { ...DEFAULT_DEV_OPTIONS, unlocked: true };
    for (const key of DEV_SWITCHES) options[key] = record[key] === true;
    return options;
  } catch {
    return { ...DEFAULT_DEV_OPTIONS };
  }
}

/** Save the options; all-default is saved as no entry. */
export function saveDevOptions(options: DevOptions, storage: DevOptionsStorage | null | undefined = devOptionsStorage()): void {
  try {
    if (!storage) return;
    const clean = options.unlocked ? options : hiddenDevOptions();
    if (!clean.unlocked) {
      storage.removeItem(DEV_OPTIONS_KEY);
      return;
    }
    storage.setItem(DEV_OPTIONS_KEY, JSON.stringify({ version: 1, ...clean }));
  } catch {
    // Storage full or disabled: the switches still hold for this session.
  }
}

/** "Hide Dev Options": locked again, every switch off. */
export function hiddenDevOptions(): DevOptions {
  return { ...DEFAULT_DEV_OPTIONS };
}

/** Taps on About's version that unlock Dev Options. */
export const DEV_UNLOCK_TAPS = 10;
/** The tap from which the countdown is shown. */
export const DEV_UNLOCK_COUNTDOWN_FROM = 7;

/**
 * What one tap on About's version does: the new count, whether this tap unlocked Dev
 * Options, and the toast to show (none before the seventh tap). `taps` is the count
 * before this tap; tapping once unlocked only says so.
 */
export function devUnlockTap(taps: number, unlocked: boolean): { taps: number; unlock: boolean; toast: string | null } {
  if (unlocked) return { taps: 0, unlock: false, toast: "Dev Options already unlocked" };
  const next = taps + 1;
  if (next >= DEV_UNLOCK_TAPS) return { taps: 0, unlock: true, toast: "Dev Options unlocked" };
  if (next < DEV_UNLOCK_COUNTDOWN_FROM) return { taps: next, unlock: false, toast: null };
  const left = DEV_UNLOCK_TAPS - next;
  return { taps: next, unlock: false, toast: `${left} ${left === 1 ? "tap" : "taps"} away from Dev Options` };
}

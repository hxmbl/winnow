/**
 * Settings → Dev Options: switches for looking under the hood, kept apart from the
 * shared preferences.
 *
 * Stored on this device only, under `winnow.devOptions.v1` as
 * `{ version: 1, purePlainText }`. Not per account (nothing here is about an account),
 * never synced, and not cleared by sign-out. Everything is off by default, and off is
 * saved as *no entry*, so turning the last one off leaves nothing behind.
 */

export const DEV_OPTIONS_KEY = "winnow.devOptions.v1";

export type DevOptions = {
  /**
   * Pure Plain Text: the reader's Plain text form shows the message's `text/plain`
   * part exactly as sent, with none of the usual tidying (`core/mail/plainView.ts`).
   */
  purePlainText: boolean;
};

export const DEFAULT_DEV_OPTIONS: DevOptions = { purePlainText: false };

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
 * only a literal `true` turns a switch on.
 */
export function loadDevOptions(storage: DevOptionsStorage | null | undefined = devOptionsStorage()): DevOptions {
  try {
    const raw = storage?.getItem(DEV_OPTIONS_KEY);
    if (raw == null) return { ...DEFAULT_DEV_OPTIONS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_DEV_OPTIONS };
    return { purePlainText: (parsed as { purePlainText?: unknown }).purePlainText === true };
  } catch {
    return { ...DEFAULT_DEV_OPTIONS };
  }
}

/** Save the options; all-default is saved as no entry. */
export function saveDevOptions(options: DevOptions, storage: DevOptionsStorage | null | undefined = devOptionsStorage()): void {
  try {
    if (!storage) return;
    if (!options.purePlainText) {
      storage.removeItem(DEV_OPTIONS_KEY);
      return;
    }
    storage.setItem(DEV_OPTIONS_KEY, JSON.stringify({ version: 1, purePlainText: true }));
  } catch {
    // Storage full or disabled: the switch still holds for this session.
  }
}

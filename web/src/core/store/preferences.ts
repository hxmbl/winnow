/**
 * Reading preferences back from storage.
 *
 * Lives in `core` rather than in `main.tsx`, so the rules about what survives a
 * restart — which keys, which values, which migrations — are unit-tested instead of
 * being exercised only by the smoke run.
 */

import { isAccentTheme, isAppearance } from "../model/appearance";
import type { Preferences } from "./store";

/** Preferences, keeping only the keys and values the current build knows about. */
export function revivePreferences(raw: unknown): Partial<Preferences> | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const out: Partial<Preferences> = {};

  if (source.sortBy === "date" || source.sortBy === "sender" || source.sortBy === "score") {
    out.sortBy = source.sortBy;
  }
  // An unknown mode or accent — a value from a newer build, or a hand-edited blob — is
  // dropped rather than guessed at, so the default applies and the app still paints.
  if (isAppearance(source.appearance)) out.appearance = source.appearance;
  if (isAccentTheme(source.accent)) out.accent = source.accent;
  /*
   * The image policy, with the old boolean read as a migration rather than dropped:
   * `true` maps to `always` and `false` to `never`, which is exactly what each setting
   * meant. Resetting someone who had already answered would be wrong in either direction.
   */
  if (source.imagePolicy === "ask" || source.imagePolicy === "always" || source.imagePolicy === "never") {
    out.imagePolicy = source.imagePolicy;
  } else if (typeof source.loadRemoteContent === "boolean") {
    out.imagePolicy = source.loadRemoteContent ? "always" : "never";
  }
  if (typeof source.brandLogos === "boolean") out.brandLogos = source.brandLogos;
  if (typeof source.gravatars === "boolean") out.gravatars = source.gravatars;
  if (typeof source.notificationsEnabled === "boolean") {
    out.notificationsEnabled = source.notificationsEnabled;
  }
  if (typeof source.backgroundSync === "boolean") out.backgroundSync = source.backgroundSync;
  if (typeof source.backgroundSyncInterval === "number" && source.backgroundSyncInterval > 0) {
    out.backgroundSyncInterval = source.backgroundSyncInterval;
  }
  // Addresses are matched case-insensitively everywhere they are read, so the
  // comparison is on the lowercased form — but the *stored* form is kept, because it
  // is what the settings panel shows and it is the address the user recognised.
  if (Array.isArray(source.blockedSenders)) {
    out.blockedSenders = source.blockedSenders.filter(
      (sender): sender is string => typeof sender === "string" && sender.includes("@"),
    );
  }
  if (Array.isArray(source.mutedSenders)) {
    out.mutedSenders = source.mutedSenders.filter(
      (sender): sender is string => typeof sender === "string" && sender.includes("@"),
    );
  }
  return out;
}

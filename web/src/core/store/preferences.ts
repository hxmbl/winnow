/**
 * Reading preferences back from storage, and writing them safely.
 *
 * Lives in `core` rather than in `main.tsx`, so the rules about what survives a
 * restart — which keys, which values, which migrations, and how a partial patch is
 * merged — are unit-tested instead of being exercised only by the smoke run.
 */

import { isAccentPreference, isAppearance, normalizeHexColor } from "../model/appearance";
import { reviveUndoSendSeconds } from "../mail/undoSend";
import { isCensorLevel } from "../mail/censor";
import { DEFAULT_NOTIFICATION_ACTIONS } from "../notify/notifications";
import type { KeyValueStorage } from "../session/accounts";
import type { Preferences } from "./store";
import { readJson, writeJson } from "./storage";

/** The one shared preferences slot (1.3.5's spelling, still current). */
export const PREFERENCES_KEY = "winnow.preferences.v1";

/**
 * The preferences stored on this device, or `null` on a first run.
 *
 * A blob the current build understands nothing in reads as `{}` rather than as a
 * failure: every default still applies, and the next write replaces it.
 */
export function loadPreferences(storage: KeyValueStorage | null): Partial<Preferences> | null {
  const raw = readJson(storage, PREFERENCES_KEY);
  return raw === null ? null : revivePreferences(raw);
}

/**
 * Merge a persist patch into the stored preferences.
 *
 * The patch is a *partial* — `{ blockedSenders: [...] }` from a block action — so
 * writing it verbatim would replace the whole blob with that one field, silently
 * reverting appearance and sort order on the next launch. Reading first and spreading
 * is what makes a partial patch mean "change this, keep the rest".
 */
export function persistPreferences(storage: KeyValueStorage | null, patch: Partial<Preferences>): void {
  const current = loadPreferences(storage) ?? {};
  writeJson(storage, PREFERENCES_KEY, { ...current, ...patch });
}

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
  if (isAccentPreference(source.accent)) out.accent = source.accent;
  // The custom colour (1.4.0): a hex, normalised; anything else is dropped and the default
  // colour stands. An older blob simply has none. `accent: "custom"` without a colour is
  // still honoured, and paints the default custom colour.
  const accentCustom = normalizeHexColor(source.accentCustom);
  if (accentCustom) out.accentCustom = accentCustom;
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
  if (typeof source.markReadOnOpen === "boolean") out.markReadOnOpen = source.markReadOnOpen;
  if (typeof source.swipeActions === "boolean") out.swipeActions = source.swipeActions;
  if (typeof source.leftHanded === "boolean") out.leftHanded = source.leftHanded;
  // Blur sensitive info, with the old on/off "Censor email addresses" read as its first
  // step: on meant email addresses, which is exactly what "emails" blurs.
  if (isCensorLevel(source.censorLevel)) out.censorLevel = source.censorLevel;
  else if (typeof source.censorEmails === "boolean") out.censorLevel = source.censorEmails ? "emails" : "off";
  if (typeof source.emailDarkMode === "boolean") out.emailDarkMode = source.emailDarkMode;
  if (typeof source.driveLinks === "boolean") out.driveLinks = source.driveLinks;
  // Only a delay Settings offers (or the retired 30 s, read as 20 s): anything else (a
  // newer build's choice, a hand edit) falls back to the default rather than being
  // rounded to a neighbour.
  const undoSendSeconds = reviveUndoSendSeconds(source.undoSendSeconds);
  if (undoSendSeconds !== null) out.undoSendSeconds = undoSendSeconds;
  if (typeof source.notificationsEnabled === "boolean") {
    out.notificationsEnabled = source.notificationsEnabled;
  }
  // Each button on its own: a missing or non-boolean one keeps its default (on), so an
  // older blob or a newer build's extra button never switches the others off.
  if (source.notificationActions && typeof source.notificationActions === "object") {
    const actions = source.notificationActions as Record<string, unknown>;
    out.notificationActions = {
      reply: typeof actions.reply === "boolean" ? actions.reply : DEFAULT_NOTIFICATION_ACTIONS.reply,
      trash: typeof actions.trash === "boolean" ? actions.trash : DEFAULT_NOTIFICATION_ACTIONS.trash,
      read: typeof actions.read === "boolean" ? actions.read : DEFAULT_NOTIFICATION_ACTIONS.read,
    };
  }
  if (typeof source.unreadBadge === "boolean") out.unreadBadge = source.unreadBadge;
  if (typeof source.notificationHidePreview === "boolean") {
    out.notificationHidePreview = source.notificationHidePreview;
  }
  // The first-run tour (1.5): only a boolean counts; anything else reads as not done,
  // which on its own never opens the tour for a device that has run Winnow before.
  if (typeof source.tourDone === "boolean") out.tourDone = source.tourDone;
  if (typeof source.backgroundSync === "boolean") out.backgroundSync = source.backgroundSync;
  if (typeof source.backgroundSyncInterval === "number" && source.backgroundSyncInterval > 0) {
    out.backgroundSyncInterval = source.backgroundSyncInterval;
  }
  if (typeof source.gmailListener === "boolean") out.gmailListener = source.gmailListener;
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

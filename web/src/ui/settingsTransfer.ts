/**
 * Settings → About → Export settings / Import settings…: a small JSON file of how Winnow
 * is set up on this device, to move to another device or to share.
 *
 * **An allowlist, never a dump.** Only the keys in `EXPORTED_SETTINGS` are written or
 * read, each validated the same way storage is read back (`revivePreferences`). Nothing
 * else on the device can reach the file: no sign-in or tokens, no Google client, no
 * account addresses or ids, no mail, drafts or contacts, nothing Winnow has learnt
 * (sorting weights, smart-filter corrections and sender rules), no hidden or muted
 * senders (they are email addresses), and no per-device state such as the tour or the
 * last update check. `settingsTransfer.test.ts` pins the list, so adding a key is a
 * decision someone makes on purpose.
 *
 * Pure: no DOM, no storage. `SettingsPanel.tsx` reads and writes the file;
 * `useSettingsTransfer.ts` gathers the values and applies an import.
 */

import type { Preferences } from "../core/store/store";
import { revivePreferences } from "../core/store/preferences";
import { DEFAULT_DEV_OPTIONS, DEV_SWITCHES, type DevOptions } from "./devOptions";
import { SETTINGS } from "./settingsCatalog";

/** What the file says it is, so another JSON file is refused rather than half-read. */
export const SETTINGS_FILE_FORMAT = "winnow-settings";

/**
 * The file's version. Raise it only when a key changes meaning; a new key needs no bump,
 * because a reader ignores keys it does not know.
 */
export const SETTINGS_FILE_VERSION = 1;

/** The preference keys that are exported, in the order the file lists them. */
export const EXPORTED_PREFERENCE_KEYS = [
  "appearance",
  "accent",
  "accentCustom",
  "emailDarkMode",
  "leftHanded",
  "sortBy",
  "markReadOnOpen",
  "swipeActions",
  "undoSendSeconds",
  "driveLinks",
  "imagePolicy",
  "brandLogos",
  "gravatars",
  "censorLevel",
  "notificationsEnabled",
  "notificationActions",
  "notificationHidePreview",
  "unreadBadge",
  "backgroundSync",
  "backgroundSyncInterval",
] as const satisfies ReadonlyArray<keyof Preferences>;

/**
 * Preference keys that are deliberately left out, with why. Every key of `Preferences`
 * is in one list or the other (the test checks), so a new preference cannot slip into
 * the file, or out of it, unnoticed.
 */
export const NOT_EXPORTED_PREFERENCE_KEYS = {
  blockedSenders: "email addresses of people who write to you",
  mutedSenders: "email addresses of people who write to you",
  tourDone: "whether this device has seen the tour",
} as const satisfies Partial<Record<keyof Preferences, string>>;

/** Dev Options in the file: whether the category is shown, and each switch. */
export const EXPORTED_DEV_KEYS = ["devOptionsUnlocked", ...DEV_SWITCHES] as const;

/** Everything else the file carries: the update switch and the reader's width. */
export const EXPORTED_OTHER_KEYS = ["autoCheckUpdates", "readerFraction"] as const;

/** Every key the file may hold. Anything else in a file is ignored. */
export const EXPORTED_SETTINGS = [...EXPORTED_PREFERENCE_KEYS, ...EXPORTED_OTHER_KEYS, ...EXPORTED_DEV_KEYS] as const;

export type ExportedPreferenceKey = (typeof EXPORTED_PREFERENCE_KEYS)[number];
export type ExportedKey = (typeof EXPORTED_SETTINGS)[number];

/** The settings as the file holds them: flat, allowlisted, every value valid. */
export type ExportedSettings = Partial<
  Pick<Preferences, ExportedPreferenceKey> & {
    autoCheckUpdates: boolean;
    readerFraction: number;
    devOptionsUnlocked: boolean;
  } & Record<(typeof DEV_SWITCHES)[number], boolean>
>;

export type SettingsFile = {
  format: typeof SETTINGS_FILE_FORMAT;
  version: number;
  /** The Winnow that wrote it, for a person reading the file. Not checked. */
  app?: string;
  exportedAt?: string;
  settings: ExportedSettings;
};

/** What the app hands over to export: the live values. */
export type SettingsSources = {
  preferences: Preferences;
  dev: DevOptions;
  autoCheckUpdates: boolean;
  readerFraction: number;
};

const PREFERENCE_KEY_SET: ReadonlySet<string> = new Set(EXPORTED_PREFERENCE_KEYS);
const DEV_SWITCH_SET: ReadonlySet<string> = new Set(DEV_SWITCHES);

/** The values to export, taken from the live ones through the allowlist and nothing else. */
export function collectSettings(sources: SettingsSources): ExportedSettings {
  const out: Record<string, unknown> = {};
  for (const key of EXPORTED_PREFERENCE_KEYS) out[key] = sources.preferences[key];
  out.autoCheckUpdates = sources.autoCheckUpdates;
  out.readerFraction = sources.readerFraction;
  out.devOptionsUnlocked = sources.dev.unlocked;
  for (const key of DEV_SWITCHES) out[key] = sources.dev[key];
  // Through the same validation as an import, so a file is always one Winnow reads back.
  return validateSettings(out).settings;
}

/** The file's text: pretty-printed, so it can be read and shared as it is. */
export function serialiseSettings(
  settings: ExportedSettings,
  meta: { app?: string | null; now?: Date } = {},
): string {
  const file: SettingsFile = {
    format: SETTINGS_FILE_FORMAT,
    version: SETTINGS_FILE_VERSION,
    ...(meta.app ? { app: meta.app } : {}),
    exportedAt: (meta.now ?? new Date()).toISOString(),
    settings: validateSettings(settings).settings,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** `winnow-settings-2026-10-28.json`, by the local date. */
export function settingsFileName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `winnow-settings-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/**
 * Keep only allowlisted keys with values this build accepts. `ignored` names the keys
 * dropped, unknown or invalid, so an import can say so.
 */
export function validateSettings(raw: unknown): { settings: ExportedSettings; ignored: string[] } {
  const settings: Record<string, unknown> = {};
  const ignored: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { settings, ignored };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const valid = validValue(key, value);
    if (valid === undefined) ignored.push(key);
    else settings[key] = valid;
  }
  // In the allowlist's order, so a file and a diff always read the same way.
  const ordered: Record<string, unknown> = {};
  for (const key of EXPORTED_SETTINGS) if (key in settings) ordered[key] = settings[key];
  return { settings: ordered as ExportedSettings, ignored };
}

function validValue(key: string, value: unknown): unknown {
  if (PREFERENCE_KEY_SET.has(key)) {
    // The reviver fills a partial notificationActions with defaults, which is right for a
    // partial object; anything that is not an object at all is dropped instead.
    if (key === "notificationActions" && (!value || typeof value !== "object" || Array.isArray(value))) return undefined;
    const revived = revivePreferences({ [key]: value }) as Record<string, unknown> | null;
    return revived?.[key];
  }
  if (key === "devOptionsUnlocked" || key === "autoCheckUpdates" || DEV_SWITCH_SET.has(key)) {
    return typeof value === "boolean" ? value : undefined;
  }
  if (key === "readerFraction") {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1
      ? Math.round(value * 10_000) / 10_000
      : undefined;
  }
  return undefined;
}

export type ParseResult =
  | { ok: true; settings: ExportedSettings; ignored: string[]; version: number }
  | { ok: false; reason: string };

/** A chosen file's text, read as a settings file or refused with a sentence why. */
export function parseSettingsFile(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file isn't a Winnow settings file (it isn't valid JSON)." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "That file isn't a Winnow settings file." };
  }
  const file = raw as Record<string, unknown>;
  if (file.format !== SETTINGS_FILE_FORMAT) return { ok: false, reason: "That file isn't a Winnow settings file." };
  const version = file.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: "That settings file has no version Winnow understands." };
  }
  if (version > SETTINGS_FILE_VERSION) {
    return { ok: false, reason: "That settings file is from a newer Winnow. Update Winnow, then import it again." };
  }
  if (!file.settings || typeof file.settings !== "object" || Array.isArray(file.settings)) {
    return { ok: false, reason: "That settings file has no settings in it." };
  }
  const { settings, ignored } = validateSettings(file.settings);
  return { ok: true, settings, ignored, version };
}

export type SettingChange = { key: ExportedKey; label: string; from: string; to: string };

/** What an import would change, in the file's order; keys that already match are left out. */
export function diffSettings(current: ExportedSettings, incoming: ExportedSettings): SettingChange[] {
  const changes: SettingChange[] = [];
  for (const key of EXPORTED_SETTINGS) {
    if (!(key in incoming)) continue;
    const to = incoming[key];
    const from = current[key];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push({ key, label: settingLabel(key), from: describeValue(key, from), to: describeValue(key, to) });
  }
  return changes;
}

/** An import, split by where each part is kept. Only keys that are present. */
export function splitSettings(settings: ExportedSettings): {
  preferences: Partial<Preferences>;
  dev: Partial<DevOptions>;
  autoCheckUpdates?: boolean;
  readerFraction?: number;
} {
  const preferences: Record<string, unknown> = {};
  const dev: Record<string, unknown> = {};
  for (const key of EXPORTED_PREFERENCE_KEYS) if (key in settings) preferences[key] = settings[key];
  if (settings.devOptionsUnlocked !== undefined) dev.unlocked = settings.devOptionsUnlocked;
  for (const key of DEV_SWITCHES) if (settings[key] !== undefined) dev[key] = settings[key];
  return {
    preferences: preferences as Partial<Preferences>,
    dev: dev as Partial<DevOptions>,
    ...(settings.autoCheckUpdates !== undefined ? { autoCheckUpdates: settings.autoCheckUpdates } : {}),
    ...(settings.readerFraction !== undefined ? { readerFraction: settings.readerFraction } : {}),
  };
}

/**
 * Dev Options after an import: the file's values over the current ones. A locked
 * category has every switch off (`saveDevOptions` would drop them anyway), so a file
 * that hides Dev Options turns them all off rather than leaving hidden switches on.
 */
export function mergeDevOptions(current: DevOptions, patch: Partial<DevOptions>): DevOptions {
  const next = { ...current, ...patch };
  return next.unlocked ? next : { ...DEFAULT_DEV_OPTIONS };
}

/** The name a change is listed under: the row's own label where there is one. */
export function settingLabel(key: ExportedKey): string {
  switch (key) {
    case "appearance":
      return SETTINGS.themeMode.label;
    case "accent":
      return SETTINGS.accent.label;
    case "accentCustom":
      return "Custom accent colour";
    case "emailDarkMode":
      return SETTINGS.emailDarkMode.label;
    case "leftHanded":
      return SETTINGS.leftHanded.label;
    case "sortBy":
      return SETTINGS.sortBy.label;
    case "markReadOnOpen":
      return SETTINGS.markReadOnOpen.label;
    case "swipeActions":
      return SETTINGS.swipeActions.label;
    case "undoSendSeconds":
      return SETTINGS.undoSend.label;
    case "driveLinks":
      return SETTINGS.driveLinks.label;
    case "imagePolicy":
      return SETTINGS.remoteImages.label;
    case "brandLogos":
      return SETTINGS.brandLogos.label;
    case "gravatars":
      return SETTINGS.gravatars.label;
    case "censorLevel":
      return SETTINGS.censorLevel.label;
    case "notificationsEnabled":
      return SETTINGS.notifications.label;
    case "notificationActions":
      return SETTINGS.notificationActions.label;
    case "notificationHidePreview":
      return SETTINGS.notificationPrivacy.label;
    case "unreadBadge":
      return SETTINGS.unreadBadge.label;
    case "backgroundSync":
      return SETTINGS.backgroundSync.label;
    case "backgroundSyncInterval":
      return `Background sync: ${SETTINGS.syncInterval.label.toLowerCase()}`;
    case "autoCheckUpdates":
      return "Check for updates automatically";
    case "readerFraction":
      return "Reader width";
    case "devOptionsUnlocked":
      return "Show Dev Options";
    case "purePlainText":
      return SETTINGS.purePlainText.label;
    case "viewOriginal":
      return SETTINGS.viewOriginal.label;
    case "filterScores":
      return SETTINGS.filterScores.label;
    case "debugLog":
      return SETTINGS.debugLog.label;
    case "betaUpdates":
      return SETTINGS.betaUpdates.label;
  }
}

const WORDS: Record<string, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
  oled: "Very dark",
  date: "Date",
  sender: "Sender",
  score: "Smart Score",
  ask: "Ask each time",
  always: "Always",
  never: "Never",
  off: "Off",
  emails: "Email addresses",
  passwords: "Passwords",
  addresses: "Postal addresses",
  names: "Names",
  custom: "Custom",
};

/** A value as the change list shows it: "On", "10 seconds", "Very dark". */
export function describeValue(key: ExportedKey, value: unknown): string {
  if (value === undefined || value === null) return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (key === "undoSendSeconds" && typeof value === "number") return value === 0 ? "Off" : `${value} seconds`;
  if (key === "backgroundSyncInterval" && typeof value === "number") {
    return value % 60 === 0 ? `${value / 60} min` : `${value} s`;
  }
  if (key === "readerFraction" && typeof value === "number") return `${Math.round(value * 100)}%`;
  if (key === "notificationActions" && typeof value === "object") {
    const actions = value as Preferences["notificationActions"];
    const on = [actions.trash && "Delete", actions.read && "Mark read", actions.reply && "Reply"].filter(Boolean);
    return on.length ? on.join(", ") : "None";
  }
  if (typeof value === "string") return WORDS[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
  return String(value);
}

import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, type Preferences } from "../core/store/store";
import { DEFAULT_DEV_OPTIONS, DEV_SWITCHES } from "./devOptions";
import {
  EXPORTED_PREFERENCE_KEYS,
  EXPORTED_SETTINGS,
  NOT_EXPORTED_PREFERENCE_KEYS,
  SETTINGS_FILE_FORMAT,
  SETTINGS_FILE_VERSION,
  collectSettings,
  diffSettings,
  mergeDevOptions,
  parseSettingsFile,
  serialiseSettings,
  settingsFileName,
  splitSettings,
  validateSettings,
  type SettingsSources,
} from "./settingsTransfer";
import { exportedMessage } from "./useSettingsTransfer";

function sources(overrides: Partial<Preferences> = {}): SettingsSources {
  return {
    preferences: {
      ...DEFAULT_PREFERENCES,
      blockedSenders: ["spam@example.com"],
      mutedSenders: ["boss@example.com"],
      tourDone: true,
      ...overrides,
    },
    dev: { ...DEFAULT_DEV_OPTIONS },
    autoCheckUpdates: true,
    readerFraction: 0.38,
  };
}

describe("the export allowlist", () => {
  it("is exactly this list, so adding a key is a decision", () => {
    expect([...EXPORTED_SETTINGS]).toEqual([
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
      "gmailListener",
      "autoCheckUpdates",
      "readerFraction",
      "devOptionsUnlocked",
      "purePlainText",
      "viewOriginal",
      "filterScores",
      "debugLog",
      "betaUpdates",
    ]);
  });

  it("puts every preference either in the file or on the not-exported list", () => {
    const covered = new Set<string>([...EXPORTED_PREFERENCE_KEYS, ...Object.keys(NOT_EXPORTED_PREFERENCE_KEYS)]);
    expect(Object.keys(DEFAULT_PREFERENCES).filter((key) => !covered.has(key))).toEqual([]);
    for (const key of Object.keys(NOT_EXPORTED_PREFERENCE_KEYS)) {
      expect((EXPORTED_SETTINGS as readonly string[]).includes(key)).toBe(false);
    }
  });

  it("covers every Dev Options switch", () => {
    for (const key of DEV_SWITCHES) expect((EXPORTED_SETTINGS as readonly string[]).includes(key)).toBe(true);
  });
});

describe("collectSettings and serialiseSettings", () => {
  it("never writes senders, the tour, tokens or anything outside the allowlist", () => {
    const live = sources({ appearance: "oled", accent: "ember" });
    // Things that must never reach the file even if a caller hands them over.
    (live.preferences as unknown as Record<string, unknown>).tokens = { access_token: "ya29.secret" };
    (live.preferences as unknown as Record<string, unknown>).email = "me@example.com";
    const text = serialiseSettings(collectSettings(live), { app: "Winnow 1.7.0", now: new Date("2026-10-28T21:00:00Z") });
    expect(text).not.toMatch(/@example\.com/);
    expect(text).not.toMatch(/ya29|token|tourDone|blockedSenders|mutedSenders|"email"/);
    const file = JSON.parse(text);
    expect(file).toMatchObject({
      format: SETTINGS_FILE_FORMAT,
      version: SETTINGS_FILE_VERSION,
      app: "Winnow 1.7.0",
      exportedAt: "2026-10-28T21:00:00.000Z",
    });
    expect(Object.keys(file.settings)).toEqual([...EXPORTED_SETTINGS]);
    expect(file.settings.appearance).toBe("oled");
    expect(file.settings.accent).toBe("ember");
    expect(file.settings.readerFraction).toBe(0.38);
  });

  it("round-trips through parseSettingsFile unchanged", () => {
    const settings = collectSettings({
      ...sources({ undoSendSeconds: 20, censorLevel: "names", notificationActions: { reply: false, trash: true, read: true } }),
      dev: { ...DEFAULT_DEV_OPTIONS, unlocked: true, viewOriginal: true },
      autoCheckUpdates: false,
      readerFraction: 0.45,
    });
    const parsed = parseSettingsFile(serialiseSettings(settings));
    expect(parsed).toEqual({ ok: true, settings, ignored: [], version: SETTINGS_FILE_VERSION });
  });

  it("names the file by the local date", () => {
    expect(settingsFileName(new Date(2026, 9, 3, 12))).toBe("winnow-settings-2026-10-03.json");
  });

  it("says where the file went", () => {
    expect(exportedMessage(null, { kind: "web" }, "w.json")).toBe("Downloaded w.json.");
    expect(exportedMessage(null, { kind: "desktop" }, "w.json")).toBe("Not saved.");
    expect(exportedMessage("/home/me/w.json", { kind: "desktop" }, "w.json")).toBe("Saved to /home/me/w.json");
    expect(exportedMessage("content://downloads/1", { kind: "desktop" }, "w.json")).toBe("Saved.");
  });
});

describe("parseSettingsFile", () => {
  const wrap = (settings: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ format: SETTINGS_FILE_FORMAT, version: 1, settings, ...extra });

  it("refuses what is not a settings file", () => {
    expect(parseSettingsFile("not json").ok).toBe(false);
    expect(parseSettingsFile("[]").ok).toBe(false);
    expect(parseSettingsFile(JSON.stringify({ installed: { client_id: "x" } })).ok).toBe(false);
    expect(parseSettingsFile(JSON.stringify({ format: SETTINGS_FILE_FORMAT, version: 1 })).ok).toBe(false);
  });

  it("refuses a missing, odd or newer version", () => {
    expect(parseSettingsFile(wrap({}, { version: undefined })).ok).toBe(false);
    expect(parseSettingsFile(wrap({}, { version: "1" })).ok).toBe(false);
    expect(parseSettingsFile(wrap({}, { version: 0 })).ok).toBe(false);
    const newer = parseSettingsFile(wrap({}, { version: SETTINGS_FILE_VERSION + 1 }));
    expect(newer).toEqual({ ok: false, reason: expect.stringMatching(/newer Winnow/) });
  });

  it("ignores unknown keys and invalid values, and says which", () => {
    const parsed = parseSettingsFile(
      wrap({
        appearance: "dark",
        accent: "neon",
        undoSendSeconds: 7,
        blockedSenders: ["a@b.com"],
        tokens: "secret",
        readerFraction: 2,
        debugLog: "yes",
        betaUpdates: true,
        accentCustom: "#abc",
        notificationActions: { reply: false },
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings).toEqual({
      appearance: "dark",
      accentCustom: "#AABBCC",
      notificationActions: { reply: false, trash: true, read: true },
      betaUpdates: true,
    });
    expect([...parsed.ignored].sort()).toEqual(
      ["accent", "undoSendSeconds", "blockedSenders", "tokens", "readerFraction", "debugLog"].sort(),
    );
  });
});

describe("validateSettings", () => {
  it("drops a notificationActions that is not an object rather than defaulting it", () => {
    expect(validateSettings({ notificationActions: true }).settings).toEqual({});
    expect(validateSettings({ notificationActions: [] }).settings).toEqual({});
  });

  it("keeps the allowlist's order whatever the file's order", () => {
    expect(Object.keys(validateSettings({ betaUpdates: true, sortBy: "sender", appearance: "light" }).settings)).toEqual([
      "appearance",
      "sortBy",
      "betaUpdates",
    ]);
  });
});

describe("diffSettings", () => {
  it("lists only what changes, in words", () => {
    const current = collectSettings(sources());
    const incoming = { ...current, appearance: "oled" as const, undoSendSeconds: 0 as const, gravatars: true, readerFraction: 0.5 };
    expect(diffSettings(current, incoming)).toEqual([
      { key: "appearance", label: "Mode", from: "System", to: "Very dark" },
      { key: "undoSendSeconds", label: "Undo send window", from: "10 seconds", to: "Off" },
      { key: "gravatars", label: "Gravatar photos", from: "Off", to: "On" },
      { key: "readerFraction", label: "Reader width", from: "38%", to: "50%" },
    ]);
  });

  it("leaves out keys the file does not have", () => {
    const current = collectSettings(sources());
    expect(diffSettings(current, { sortBy: current.sortBy })).toEqual([]);
    expect(diffSettings(current, { sortBy: "score" })).toEqual([
      { key: "sortBy", label: "Sort messages by", from: "Date", to: "Smart Score" },
    ]);
  });
});

describe("applying an import", () => {
  it("splits by where each part is kept", () => {
    const split = splitSettings({ appearance: "dark", autoCheckUpdates: false, readerFraction: 0.4, devOptionsUnlocked: true, debugLog: true });
    expect(split).toEqual({
      preferences: { appearance: "dark" },
      dev: { unlocked: true, debugLog: true },
      autoCheckUpdates: false,
      readerFraction: 0.4,
    });
  });

  it("turns every Dev Options switch off when the file hides them", () => {
    const current = { ...DEFAULT_DEV_OPTIONS, unlocked: true, debugLog: true };
    expect(mergeDevOptions(current, { unlocked: false, viewOriginal: true })).toEqual(DEFAULT_DEV_OPTIONS);
    expect(mergeDevOptions(current, { viewOriginal: true })).toEqual({ ...current, viewOriginal: true });
  });
});

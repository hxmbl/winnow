/**
 * Theme persistence and selection.
 *
 * The mode and accent are two preferences like any other: chosen through the store,
 * reported to `onPersist` as a partial patch, and read back by `revivePreferences` on
 * the next launch. These tests hold each step, so a theme picked today is the theme
 * painted tomorrow — and a value the build does not know is dropped rather than painted.
 */

import { describe, expect, it } from "vitest";
import { revivePreferences } from "./preferences";
import { DEFAULT_PREFERENCES, WinnowStore, type Preferences } from "./store";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import { ACCENT_THEMES, APPEARANCES, DEFAULT_ACCENT_CUSTOM, isAccentPreference, isAccentTheme, isAppearance } from "../model/appearance";

function demoStore(preferences?: Partial<Preferences>) {
  return new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH, preferences });
}

describe("theme defaults", () => {
  it("starts on System and Space", () => {
    expect(DEFAULT_PREFERENCES.appearance).toBe("system");
    expect(DEFAULT_PREFERENCES.accent).toBe("space");
    expect(demoStore().getSnapshot().preferences).toMatchObject({ appearance: "system", accent: "space" });
  });

  it("offers four modes, OLED among them", () => {
    expect([...APPEARANCES]).toEqual(["system", "light", "dark", "oled"]);
  });

  it("recognises only its own names", () => {
    for (const mode of APPEARANCES) expect(isAppearance(mode)).toBe(true);
    for (const accent of ACCENT_THEMES) expect(isAccentTheme(accent)).toBe(true);
    for (const junk of ["", "Dark", "sepia", null, 3, undefined, {}]) {
      expect(isAppearance(junk)).toBe(false);
      expect(isAccentTheme(junk)).toBe(false);
    }
  });
});

describe("theme selection", () => {
  it("applies a chosen mode and accent and reports only those keys", () => {
    const patches: unknown[] = [];
    const store = demoStore();
    store.attach({ onPersist: (patch) => patches.push(patch) });

    store.setPreferences({ appearance: "oled" });
    store.setPreferences({ accent: "ember" });

    expect(store.getSnapshot().preferences).toMatchObject({ appearance: "oled", accent: "ember" });
    // Partial patches: the persistence layer merges them, so choosing an accent must not
    // carry a stale copy of every other preference along with it.
    expect(patches).toEqual([{ preferences: { appearance: "oled" } }, { preferences: { accent: "ember" } }]);
  });

  it("keeps the accent when the mode changes, and the mode when the accent does", () => {
    const store = demoStore({ appearance: "dark", accent: "plum" });
    store.setPreferences({ appearance: "light" });
    expect(store.getSnapshot().preferences.accent).toBe("plum");
    store.setPreferences({ accent: "aurora" });
    expect(store.getSnapshot().preferences.appearance).toBe("light");
  });

  it("starts with what the last session chose, before anything renders", () => {
    const store = demoStore({ appearance: "oled", accent: "aurora" });
    expect(store.getSnapshot().preferences).toMatchObject({ appearance: "oled", accent: "aurora" });
  });
});

describe("theme persistence", () => {
  it("revives every mode and accent the build knows", () => {
    for (const appearance of APPEARANCES) {
      for (const accent of ACCENT_THEMES) {
        expect(revivePreferences({ appearance, accent })).toEqual({ appearance, accent });
      }
    }
  });

  it("round-trips through JSON as the app stores it", () => {
    const stored = JSON.stringify({ ...DEFAULT_PREFERENCES, appearance: "oled", accent: "ember" });
    const revived = revivePreferences(JSON.parse(stored));
    expect(revived).toMatchObject({ appearance: "oled", accent: "ember" });
  });

  it("drops an unknown mode or accent rather than painting it", () => {
    expect(revivePreferences({ appearance: "sepia", accent: "neon" })).toEqual({});
    expect(revivePreferences({ appearance: "DARK", accent: 2 })).toEqual({});
  });

  it("revives the custom accent and its colour, normalised (1.4.0)", () => {
    expect(revivePreferences({ accent: "custom", accentCustom: "#ff8800" })).toEqual({ accent: "custom", accentCustom: "#FF8800" });
    expect(revivePreferences({ accent: "custom", accentCustom: "abc" })).toEqual({ accent: "custom", accentCustom: "#AABBCC" });
    // Custom without a colour still paints: the store fills in the default colour.
    const revived = revivePreferences({ accent: "custom" });
    expect(revived).toEqual({ accent: "custom" });
    expect(demoStore(revived ?? undefined).getSnapshot().preferences.accentCustom).toBe(DEFAULT_ACCENT_CUSTOM);
  });

  it("drops a custom colour that is not a hex, and keeps the rest", () => {
    for (const junk of ["red", "#12345", "rgb(1, 2, 3)", 0xff8800, null, {}, "#FF880080"]) {
      expect(revivePreferences({ accent: "plum", accentCustom: junk })).toEqual({ accent: "plum" });
    }
  });

  it("leaves a blob from before the custom accent exactly as it was", () => {
    // Every value stored by 1.3.x and early 1.4.0 means what it meant: no key added, none changed.
    for (const accent of ["space", "plum", "ember", "aurora"]) {
      expect(revivePreferences({ appearance: "dark", accent })).toEqual({ appearance: "dark", accent });
    }
    expect(DEFAULT_PREFERENCES.accentCustom).toBe(DEFAULT_ACCENT_CUSTOM);
    expect(isAccentPreference("custom")).toBe(true);
    expect(isAccentTheme("custom")).toBe(false);
  });

  it("reads a blob written before accents existed", () => {
    // A preferences blob from the build before the picker: no accent key, a three-way mode.
    const revived = revivePreferences({ appearance: "dark", sortBy: "date", imagePolicy: "ask" });
    expect(revived).toEqual({ appearance: "dark", sortBy: "date", imagePolicy: "ask" });
    expect(revived).not.toHaveProperty("accent");
    // …and the store fills the gap with the default.
    expect(demoStore(revived ?? undefined).getSnapshot().preferences.accent).toBe("space");
  });

  it("keeps the theme when another key is unreadable", () => {
    expect(revivePreferences({ appearance: "oled", accent: "plum", sortBy: "nonsense" })).toEqual({
      appearance: "oled",
      accent: "plum",
    });
  });

  it("returns null for something that is not a preferences object", () => {
    expect(revivePreferences(null)).toBeNull();
    expect(revivePreferences("dark")).toBeNull();
  });
});

describe("brand logos preference", () => {
  it("is off by default and survives a restart only as a boolean", () => {
    expect(DEFAULT_PREFERENCES.brandLogos).toBe(false);
    expect(revivePreferences({ brandLogos: true })).toMatchObject({ brandLogos: true });
    expect(revivePreferences({ brandLogos: "yes" })?.brandLogos).toBeUndefined();
  });
});

describe("Gravatar preference", () => {
  it("is off by default and survives a restart only as a boolean", () => {
    expect(DEFAULT_PREFERENCES.gravatars).toBe(false);
    expect(revivePreferences({ gravatars: true })).toMatchObject({ gravatars: true });
    expect(revivePreferences({ gravatars: "yes" })?.gravatars).toBeUndefined();
  });
});

describe("undo send delay", () => {
  it("defaults to ten seconds", () => {
    expect(DEFAULT_PREFERENCES.undoSendSeconds).toBe(10);
    expect(demoStore().getSnapshot().preferences.undoSendSeconds).toBe(10);
  });

  it("survives a restart, Off included", () => {
    for (const value of [0, 5, 10, 20]) {
      expect(revivePreferences({ undoSendSeconds: value })?.undoSendSeconds).toBe(value);
    }
  });

  it("reads the retired 30 s choice as the longest one left, 20 s", () => {
    expect(revivePreferences({ undoSendSeconds: 30 })?.undoSendSeconds).toBe(20);
  });

  it("drops a delay Settings does not offer, so the default applies", () => {
    for (const value of [15, -1, 60, "10", null, true]) {
      expect(revivePreferences({ undoSendSeconds: value })).not.toHaveProperty("undoSendSeconds");
    }
  });
});

describe("the Drive links preference", () => {
  it("survives a restart as a boolean and is dropped otherwise", () => {
    expect(revivePreferences({ driveLinks: false })?.driveLinks).toBe(false);
    expect(revivePreferences({ driveLinks: "no" })?.driveLinks).toBeUndefined();
  });
});

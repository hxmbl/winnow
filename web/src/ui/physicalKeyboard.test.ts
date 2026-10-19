import { describe, expect, it } from "vitest";
import { isHardwareKey, shortcutsAvailable } from "./physicalKeyboard";
import { visibleCategories } from "./settingsView";

describe("telling a real keyboard from the on-screen one", () => {
  it("counts a named key with nothing editable focused: a soft keyboard has nowhere to type", () => {
    expect(isHardwareKey({ key: "j", keyCode: 74, editable: false })).toBe(true);
    expect(isHardwareKey({ key: "Enter", keyCode: 13, editable: false })).toBe(true);
  });

  it("never counts what soft keyboards and IMEs send: Unidentified, Process, keyCode 229, composing", () => {
    expect(isHardwareKey({ key: "Unidentified", keyCode: 229, editable: true })).toBe(false);
    expect(isHardwareKey({ key: "Unidentified", editable: false })).toBe(false);
    expect(isHardwareKey({ key: "Process", editable: true })).toBe(false);
    expect(isHardwareKey({ key: "a", keyCode: 229, editable: false })).toBe(false);
    expect(isHardwareKey({ key: "a", isComposing: true, editable: false })).toBe(false);
    expect(isHardwareKey({ key: "", editable: false })).toBe(false);
  });

  it("in a text field, ordinary typing and Enter/Backspace do not count (Gboard sends those)", () => {
    expect(isHardwareKey({ key: "a", keyCode: 65, editable: true })).toBe(false);
    expect(isHardwareKey({ key: "Enter", keyCode: 13, editable: true })).toBe(false);
    expect(isHardwareKey({ key: "Backspace", keyCode: 8, editable: true })).toBe(false);
  });

  it("in a text field, keys only a real keyboard has do count: Tab, Escape, arrows, F-keys, modifiers, chords", () => {
    for (const key of ["Tab", "Escape", "ArrowDown", "Home", "F5", "Shift", "Meta"]) {
      expect(isHardwareKey({ key, editable: true }), key).toBe(true);
    }
    expect(isHardwareKey({ key: "c", ctrlKey: true, editable: true })).toBe(true);
    expect(isHardwareKey({ key: "v", metaKey: true, editable: true })).toBe(true);
    expect(isHardwareKey({ key: "F25", editable: true })).toBe(false);
  });
});

describe("Keyboard shortcuts in Settings", () => {
  it("always shows on a desktop (a pointer that hovers), as before", () => {
    expect(shortcutsAvailable({ touchOnly: false, keyboardSeen: false })).toBe(true);
  });

  it("is hidden on a touch-only device until a real keyboard is used", () => {
    expect(shortcutsAvailable({ touchOnly: true, keyboardSeen: false })).toBe(false);
    expect(shortcutsAvailable({ touchOnly: true, keyboardSeen: true })).toBe(true);
  });

  it("is left out of the category list, the rest in order", () => {
    const all = visibleCategories();
    const touch = visibleCategories({ shortcuts: false });
    expect(all).toContain("shortcuts");
    expect(touch).not.toContain("shortcuts");
    expect(touch).toEqual(all.filter((id) => id !== "shortcuts"));
  });
});

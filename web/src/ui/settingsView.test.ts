import { describe, expect, it } from "vitest";
import { CATEGORIES, SETTINGS } from "./settingsCatalog";
import {
  INFO_CLOSED,
  WIDE_SETTINGS_MIN,
  explanationFor,
  infoReducer,
  initialExplain,
  moveCategory,
  placePopover,
  pointAt,
  pointerLeft,
  selectCategory,
  settingsLayoutFor,
  visibleCategories,
} from "./settingsView";

describe("the settings layout", () => {
  it("is three columns from 1200px, two below, and the phone list under 640px", () => {
    expect(settingsLayoutFor(1440)).toBe("three");
    expect(settingsLayoutFor(WIDE_SETTINGS_MIN)).toBe("three");
    expect(settingsLayoutFor(1199)).toBe("two");
    expect(settingsLayoutFor(640)).toBe("two");
    expect(settingsLayoutFor(639)).toBe("phone");
    expect(settingsLayoutFor(390)).toBe("phone");
  });
});

describe("the category list", () => {
  const all = visibleCategories();

  it("lists every category in catalog order, Reading first", () => {
    expect(all).toEqual(CATEGORIES.map((category) => category.id));
    expect(all[0]).toBe("reading");
  });

  it("moves with the arrow keys and wraps at both ends", () => {
    expect(moveCategory(all, "reading", "ArrowDown")).toBe(all[1]);
    expect(moveCategory(all, all[1], "ArrowUp")).toBe("reading");
    expect(moveCategory(all, "reading", "ArrowUp")).toBe(all[all.length - 1]);
    expect(moveCategory(all, all[all.length - 1], "ArrowDown")).toBe("reading");
  });

  it("jumps with Home and End, and ignores other keys", () => {
    expect(moveCategory(all, "privacy", "Home")).toBe(all[0]);
    expect(moveCategory(all, "privacy", "End")).toBe(all[all.length - 1]);
    expect(moveCategory(all, "privacy", "a")).toBe("privacy");
    expect(moveCategory([], "privacy", "ArrowDown")).toBe("privacy");
  });

  it("selecting a category shows its intro", () => {
    const pointed = pointAt(initialExplain("reading"), "sortBy");
    const next = selectCategory(pointed, "privacy");
    expect(next).toEqual({ category: "privacy", pointed: null });
    expect(explanationFor(next)).toMatchObject({ kind: "intro", title: "Privacy" });
  });

  it("selecting the current category again keeps what was pointed at", () => {
    const pointed = pointAt(initialExplain("privacy"), "gravatars");
    expect(selectCategory(pointed, "privacy")).toBe(pointed);
  });
});

describe("the explanation panel", () => {
  it("starts on the category's intro", () => {
    const explanation = explanationFor(initialExplain("privacy"));
    expect(explanation.kind).toBe("intro");
    expect(explanation.body).toBe(CATEGORIES.find((c) => c.id === "privacy")!.intro);
  });

  it("shows the setting that hover or focus points at, with the catalog's copy", () => {
    const state = pointAt(initialExplain("privacy"), "brandLogos");
    expect(explanationFor(state)).toEqual({
      kind: "setting",
      setting: "brandLogos",
      title: SETTINGS.brandLogos.label,
      body: SETTINGS.brandLogos.explanation,
    });
  });

  it("stays on the last one pointed at when the pointer leaves", () => {
    const state = pointAt(initialExplain("privacy"), "gravatars");
    expect(explanationFor(pointerLeft(state)).setting).toBe("gravatars");
  });

  it("moves to the next one pointed at", () => {
    const state = pointAt(pointAt(initialExplain("privacy"), "gravatars"), "remoteImages");
    expect(explanationFor(state).setting).toBe("remoteImages");
  });

  it("ignores a setting from another category", () => {
    const state = initialExplain("privacy");
    expect(pointAt(state, "sortBy")).toBe(state);
  });

  it("returns the same state when the same setting is pointed at again", () => {
    const state = pointAt(initialExplain("privacy"), "gravatars");
    expect(pointAt(state, "gravatars")).toBe(state);
  });
});

describe("the (?) popover", () => {
  it("opens on hover and closes when the pointer leaves", () => {
    const open = infoReducer(INFO_CLOSED, { type: "hover", setting: "gravatars" });
    expect(open).toEqual({ open: "gravatars", pinned: false });
    expect(infoReducer(open, { type: "unhover", setting: "gravatars" })).toEqual(INFO_CLOSED);
  });

  it("opens on focus and closes on blur", () => {
    const open = infoReducer(INFO_CLOSED, { type: "focus", setting: "brandLogos" });
    expect(open.open).toBe("brandLogos");
    expect(infoReducer(open, { type: "blur", setting: "brandLogos" })).toEqual(INFO_CLOSED);
  });

  it("a tap pins it open, and a second tap closes it", () => {
    const pinned = infoReducer(INFO_CLOSED, { type: "press", setting: "gravatars" });
    expect(pinned).toEqual({ open: "gravatars", pinned: true });
    expect(infoReducer(pinned, { type: "unhover", setting: "gravatars" })).toBe(pinned);
    expect(infoReducer(pinned, { type: "blur", setting: "gravatars" })).toBe(pinned);
    expect(infoReducer(pinned, { type: "press", setting: "gravatars" })).toEqual(INFO_CLOSED);
  });

  it("a click on a hovered popover pins it rather than closing it", () => {
    const hovered = infoReducer(INFO_CLOSED, { type: "hover", setting: "gravatars" });
    expect(infoReducer(hovered, { type: "press", setting: "gravatars" })).toEqual({ open: "gravatars", pinned: true });
  });

  it("Escape and a tap elsewhere close it, pinned or not", () => {
    const pinned = infoReducer(INFO_CLOSED, { type: "press", setting: "gravatars" });
    expect(infoReducer(pinned, { type: "escape" })).toEqual(INFO_CLOSED);
    expect(infoReducer(pinned, { type: "outside" })).toEqual(INFO_CLOSED);
    expect(infoReducer(INFO_CLOSED, { type: "escape" })).toBe(INFO_CLOSED);
  });

  it("only one is open at a time", () => {
    const first = infoReducer(INFO_CLOSED, { type: "press", setting: "gravatars" });
    const second = infoReducer(first, { type: "hover", setting: "brandLogos" });
    expect(second).toEqual({ open: "brandLogos", pinned: false });
    // Leaving the first button no longer affects the second popover.
    expect(infoReducer(second, { type: "unhover", setting: "gravatars" })).toBe(second);
  });
});

describe("popover placement", () => {
  const viewport = { width: 390, height: 844 };

  it("sits below its button when there is room", () => {
    const place = placePopover({ top: 100, left: 300, width: 24, height: 24 }, 120, viewport);
    expect(place.side).toBe("below");
    expect(place.top).toBe(130);
  });

  it("flips above when the button is near the bottom", () => {
    const place = placePopover({ top: 780, left: 100, width: 24, height: 24 }, 120, viewport);
    expect(place.side).toBe("above");
    expect(place.top + 120).toBeLessThanOrEqual(780);
  });

  it("never leaves the viewport sideways, and narrows on a small screen", () => {
    const right = placePopover({ top: 100, left: 370, width: 20, height: 20 }, 100, viewport);
    expect(right.left + right.width).toBeLessThanOrEqual(viewport.width - 8);
    const left = placePopover({ top: 100, left: 0, width: 20, height: 20 }, 100, viewport);
    expect(left.left).toBeGreaterThanOrEqual(8);
    const tiny = placePopover({ top: 100, left: 100, width: 20, height: 20 }, 100, { width: 300, height: 600 });
    expect(tiny.width).toBe(284);
  });

  it("clamps vertically when it fits on neither side", () => {
    const place = placePopover({ top: 300, left: 100, width: 20, height: 20 }, 800, { width: 390, height: 600 });
    expect(place.top).toBeGreaterThanOrEqual(8);
  });
});

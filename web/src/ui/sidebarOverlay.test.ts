import { describe, expect, it } from "vitest";
import {
  SIDEBAR_IDLE_CLOSE_MS,
  armsIdleClose,
  firstVisible,
  idleCloseAllowed,
  scrimClickCloses,
  scrimMidpoint,
  isEditingElement,
  SCRIM_ORIGIN,
  scrimBlurAt,
  scrimLayers,
  scrimMask,
} from "./sidebarOverlay";

const idle = { pointerInside: false, menuOpen: false, editing: false, keyboardFocus: false };

/** Just enough of an element for `isEditingElement`. */
function el(tagName: string, attrs: Record<string, string> = {}, isContentEditable = false): Element {
  return {
    tagName,
    isContentEditable,
    getAttribute: (name: string) => attrs[name] ?? null,
  } as unknown as Element;
}

describe("the idle close", () => {
  it("waits about a second and a half", () => {
    expect(SIDEBAR_IDLE_CLOSE_MS).toBeGreaterThanOrEqual(1000);
    expect(SIDEBAR_IDLE_CLOSE_MS).toBeLessThanOrEqual(2000);
  });

  it("closes a sidebar nothing is using", () => {
    expect(idleCloseAllowed(idle)).toBe(true);
  });

  it("keeps it open while anything is still using it", () => {
    expect(idleCloseAllowed({ ...idle, pointerInside: true })).toBe(false);
    expect(idleCloseAllowed({ ...idle, menuOpen: true })).toBe(false);
    expect(idleCloseAllowed({ ...idle, editing: true })).toBe(false);
    expect(idleCloseAllowed({ ...idle, keyboardFocus: true })).toBe(false);
  });

  it("is armed by a mouse or a pen leaving, never by a finger lifting", () => {
    expect(armsIdleClose("mouse")).toBe(true);
    expect(armsIdleClose("pen")).toBe(true);
    expect(armsIdleClose("touch")).toBe(false);
    expect(armsIdleClose("")).toBe(false);
  });

  it("counts typing as use, and a button with focus as not", () => {
    expect(isEditingElement(el("INPUT"))).toBe(true);
    expect(isEditingElement(el("INPUT", { type: "search" }))).toBe(true);
    expect(isEditingElement(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isEditingElement(el("TEXTAREA"))).toBe(true);
    expect(isEditingElement(el("SELECT"))).toBe(true);
    expect(isEditingElement(el("DIV", {}, true))).toBe(true);
    expect(isEditingElement(el("BUTTON"))).toBe(false);
    expect(isEditingElement(null)).toBe(false);
  });
});

describe("the progressive blur-xs", () => {
  {
    const layers = scrimLayers();
    const name = "on every screen";

    it(`${name}: strongest at the sidebar, each weaker layer reaching further`, () => {
      expect(layers.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < layers.length; i += 1) {
        expect(layers[i].blur).toBeLessThan(layers[i - 1].blur);
        expect(layers[i].reach).toBeGreaterThan(layers[i - 1].reach);
      }
    });

    it(`${name}: the faintest layer fades out at the far side, none past it`, () => {
      expect(layers[layers.length - 1].reach).toBe(1);
      expect(layers.every((layer) => layer.reach > 0 && layer.reach <= 1)).toBe(true);
    });
  }

  it("is the desktop sidebar's blur-xs on the phone's panel too: one recipe, four layers", () => {
    // The phone used to get three lighter layers, which read as a weaker, different
    // effect. Now both share the recipe and differ only in where it spreads from.
    expect(scrimLayers()).toEqual([
      { blur: 16, reach: 0.12 },
      { blur: 8, reach: 0.3 },
      { blur: 4, reach: 0.55 },
      { blur: 1.5, reach: 1 },
    ]);
    // A fresh copy each call, so a caller cannot edit the shared recipe.
    expect(scrimLayers()).not.toBe(scrimLayers());
  });

  it("masks each layer as a circle around the origin, fading to nothing at its reach", () => {
    expect(scrimMask({ blur: 8, reach: 0.3 }, "var(--x) var(--y)")).toBe(
      "radial-gradient(circle farthest-corner at var(--x) var(--y), #000 0, transparent 30%)",
    );
    expect(scrimMask({ blur: 1, reach: 1 }, "248px 300px")).toBe(
      "radial-gradient(circle farthest-corner at 248px 300px, #000 0, transparent 100%)",
    );
    expect(scrimMask({ blur: 16, reach: 0.12 }, "0 0")).toMatch(/transparent 12%\)$/);
  });

  it("spreads from the middle of the sidebar's right edge", () => {
    expect(SCRIM_ORIGIN).toBe("var(--wn-sidebar-edge) var(--wn-sidebar-mid, 50%)");
  });

  for (const { name, corner } of [
    // A 1440 × 900 window with the origin at (248, 450), the middle of the sidebar's
    // right edge: the farthest corner is top right.
    { name: "on the desktop", corner: Math.hypot(1440 - 248, 450) },
    // A 390 × 844 phone with the panel grown from the pill (12px to 312px across, 400px
    // to 772px down): the origin is (312, 586), the middle of its right edge, and the
    // farthest corner is the top left.
    { name: "on a phone", corner: Math.hypot(312, 586) },
  ]) {
    const layers = scrimLayers();

    it(`${name}: weaker further away, the same at the same distance in any direction`, () => {
      let previous = Infinity;
      for (let d = 0; d <= corner; d += 40) {
        const here = scrimBlurAt(layers, d, corner);
        expect(here).toBeLessThan(previous);
        previous = here;
      }
      // Radial: the blur depends on distance alone, so 200px right, 200px down and
      // 200px up (or along a diagonal) are all the same.
      const right = scrimBlurAt(layers, Math.hypot(200, 0), corner);
      expect(scrimBlurAt(layers, Math.hypot(0, 200), corner)).toBe(right);
      expect(scrimBlurAt(layers, Math.hypot(120, 160), corner)).toBeCloseTo(right, 10);
    });

    it(`${name}: everything on at the origin, nothing at the farthest corner`, () => {
      const total = layers.reduce((sum, layer) => sum + layer.blur, 0);
      expect(scrimBlurAt(layers, 0, corner)).toBe(total);
      expect(scrimBlurAt(layers, corner, corner)).toBe(0);
      expect(scrimBlurAt(layers, corner * 0.9, corner)).toBeLessThan(layers[layers.length - 1].blur * 0.11);
    });
  }
});

describe("the idle close's edge cases", () => {
  it("holds while a press that began inside is still down (drag-select, scrollbar drag)", () => {
    expect(idleCloseAllowed({ ...idle, pressing: true })).toBe(false);
  });

  it("holds while the browser's context menu opened from inside is up", () => {
    expect(idleCloseAllowed({ ...idle, contextMenu: true })).toBe(false);
  });

  it("holds while text inside the sidebar is selected", () => {
    expect(idleCloseAllowed({ ...idle, selecting: true })).toBe(false);
  });

  it("reads the new fields as off when a caller leaves them out", () => {
    expect(idleCloseAllowed({ ...idle, pressing: false, contextMenu: false, selecting: false })).toBe(true);
    expect(idleCloseAllowed(idle)).toBe(true);
  });

  it("is never armed by touch, whatever the device also has", () => {
    expect(armsIdleClose("touch")).toBe(false);
    expect(armsIdleClose("")).toBe(false);
  });
});

describe("a click on the scrim", () => {
  it("closes on a single click", () => {
    expect(scrimClickCloses(1)).toBe(true);
  });

  it("does not close on the second click of a double-click on the toggle under it", () => {
    expect(scrimClickCloses(2)).toBe(false);
    expect(scrimClickCloses(3)).toBe(false);
  });

  it("closes for a synthetic click with no count (keyboard, assistive tech)", () => {
    expect(scrimClickCloses(0)).toBe(true);
  });
});

describe("which toggle gets focus back", () => {
  const node = (name: string, rects: number) => ({ name, getClientRects: () => ({ length: rects }) });

  it("skips a toggle that is mounted but hidden", () => {
    expect(firstVisible([node("masthead", 0), node("reader", 1)])?.name).toBe("reader");
  });

  it("takes the first visible one in document order", () => {
    expect(firstVisible([node("a", 1), node("b", 1)])?.name).toBe("a");
  });

  it("gives nothing rather than a hidden toggle", () => {
    expect(firstVisible([node("a", 0)])).toBeNull();
    expect(firstVisible([])).toBeNull();
  });
});

describe("the scrim's measured origin", () => {
  it("is the middle of the panel, rounded", () => {
    expect(scrimMidpoint({ top: 8, height: 301 })).toBe("159px");
  });

  it("falls back to the window's middle for a panel with no height", () => {
    expect(scrimMidpoint({ top: 8, height: 0 })).toBeNull();
    expect(scrimMidpoint({ top: 0, height: -4 })).toBeNull();
  });

  it("ignores a measurement that is not a number", () => {
    expect(scrimMidpoint({ top: Number.NaN, height: 200 })).toBeNull();
    expect(scrimMidpoint({ top: 8, height: Number.POSITIVE_INFINITY })).toBeNull();
  });
});


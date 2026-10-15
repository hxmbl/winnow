import { describe, expect, it } from "vitest";
import {
  SIDEBAR_IDLE_CLOSE_MS,
  armsIdleClose,
  idleCloseAllowed,
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

describe("the progressive blur", () => {
  for (const compact of [false, true]) {
    const layers = scrimLayers(compact);
    const name = compact ? "on a phone" : "on the desktop";

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

  it("is lighter on a phone: fewer layers, and a weaker strongest one", () => {
    const phone = scrimLayers(true);
    const desktop = scrimLayers(false);
    expect(phone.length).toBeLessThan(desktop.length);
    expect(phone[0].blur).toBeLessThan(desktop[0].blur);
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

  for (const compact of [false, true]) {
    const layers = scrimLayers(compact);
    const name = compact ? "on a phone" : "on the desktop";
    // A 1440 × 900 window with the origin at (248, 450): the farthest corner is top right.
    const corner = Math.hypot(1440 - 248, 450);

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

import { describe, expect, it } from "vitest";
import {
  SIDEBAR_IDLE_CLOSE_MS,
  armsIdleClose,
  idleCloseAllowed,
  isEditingElement,
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

  it("masks each layer opaque up to the sidebar's edge, then fades it out", () => {
    expect(scrimMask({ blur: 8, reach: 0.3 }, "var(--edge)")).toBe(
      "linear-gradient(to right, #000 0, #000 var(--edge), transparent calc(var(--edge) + (100% - var(--edge)) * 0.3))",
    );
    expect(scrimMask({ blur: 1, reach: 1 }, "248px")).toBe(
      "linear-gradient(to right, #000 0, #000 248px, transparent 100%)",
    );
  });
});

import { describe, expect, it } from "vitest";
import { BACK_ORDER, ROOT_STATE, backTarget, isSheetElement, type BackLayer, type BackState } from "./backLayers";

const open = (...layers: BackLayer[]): BackState =>
  Object.fromEntries(BACK_ORDER.map((layer) => [layer, layers.includes(layer)])) as BackState;

describe("Android Back", () => {
  it("leaves the app only from the bare list", () => {
    expect(backTarget(ROOT_STATE)).toBe("exit");
  });

  it("closes each layer on its own", () => {
    for (const layer of BACK_ORDER) expect(backTarget(open(layer))).toBe(layer);
  });

  it("closes the topmost layer first: popover, sheet, composer, sidebar, Settings, message", () => {
    expect(BACK_ORDER).toEqual(["popover", "sheet", "composer", "sidebar", "settings", "message"]);
    // Everything open: one press per layer, in order, then out.
    let state = open(...BACK_ORDER);
    const closed: (BackLayer | "exit")[] = [];
    for (let press = 0; press <= BACK_ORDER.length; press += 1) {
      const target = backTarget(state);
      closed.push(target);
      if (target !== "exit") state = { ...state, [target]: false };
    }
    expect(closed).toEqual([...BACK_ORDER, "exit"]);
  });

  it("closes a menu over a message before the message", () => {
    expect(backTarget(open("message", "popover"))).toBe("popover");
  });

  it("closes a discard confirmation before the composer under it", () => {
    expect(backTarget(open("composer", "sheet", "message"))).toBe("sheet");
  });

  it("parks the composer before closing the message it answers", () => {
    expect(backTarget(open("composer", "message"))).toBe("composer");
  });

  it("closes the sidebar before Settings, and Settings before the message", () => {
    expect(backTarget(open("sidebar", "settings", "message"))).toBe("sidebar");
    expect(backTarget(open("settings", "message"))).toBe("settings");
  });
});

describe("which modals count as a sheet", () => {
  const modal = (inner: string | null, modalAttr = "true") => ({
    getAttribute: (name: string) => (name === "aria-modal" ? modalAttr : null),
    querySelector: (selector: string) =>
      inner && selector.split(", ").some((part) => part === `[${inner}]`) ? ({} as Element) : null,
  });

  it("is a confirmation, the setup sheet, the shortcut sheet or the palette", () => {
    expect(isSheetElement(modal(null))).toBe(true);
  });

  it("is never the composer, the sidebar or Settings, which are layers of their own", () => {
    expect(isSheetElement(modal("data-composer"))).toBe(false);
    expect(isSheetElement(modal("data-mail-nav"))).toBe(false);
    expect(isSheetElement(modal("data-settings-layout"))).toBe(false);
  });

  it("is never a closed sidebar, which is not modal", () => {
    expect(isSheetElement(modal(null, "false"))).toBe(false);
  });
});

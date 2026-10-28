import { describe, expect, it } from "vitest";
import { ROW_TAP_IGNORE, rowTapSwitch, type RowTapSwitch } from "./settingsRowTap";

/** A stand-in element: `closest` answers for the selectors it is listed as matching. */
function el(matches: string[] = []) {
  return {
    closest(selector: string) {
      const wanted = selector.split(",").map((part) => part.trim());
      return wanted.some((part) => matches.includes(part)) ? {} : null;
    },
  };
}
function sw(attrs: Record<string, string> = {}, disabled = false): RowTapSwitch {
  return { disabled, getAttribute: (name) => attrs[name] ?? null };
}
function block(...switches: RowTapSwitch[]) {
  return { querySelectorAll: () => switches };
}

describe("rowTapSwitch", () => {
  it("a tap on the row's name or padding presses its one switch", () => {
    const only = sw();
    expect(rowTapSwitch(el(), block(only))).toBe(only);
  });

  it("the (?) help button keeps its own action", () => {
    expect(rowTapSwitch(el(["button", "[data-setting-info]"]), block(sw()))).toBeNull();
    expect(ROW_TAP_IGNORE).toContain("[data-setting-info]");
  });

  it("a tap on the switch itself is the switch's, not passed on a second time", () => {
    expect(rowTapSwitch(el(['[role="switch"]', "button"]), block(sw()))).toBeNull();
  });

  it("links, fields and menus inside a row are left alone", () => {
    for (const selector of ["a[href]", "input", "select", '[role="listbox"]', '[role="tooltip"]']) {
      expect(rowTapSwitch(el([selector]), block(sw()))).toBeNull();
    }
  });

  it("a row with no switch, or with two, does nothing", () => {
    expect(rowTapSwitch(el(), block())).toBeNull();
    expect(rowTapSwitch(el(), block(sw(), sw()))).toBeNull();
  });

  it("a disabled switch is not pressed", () => {
    expect(rowTapSwitch(el(), block(sw({}, true)))).toBeNull();
    expect(rowTapSwitch(el(), block(sw({ "aria-disabled": "true" })))).toBeNull();
  });

  it("finishing a text selection on the name does not flip it", () => {
    expect(rowTapSwitch(el(), block(sw()), "Keep syncing")).toBeNull();
  });

  it("no target, no press", () => {
    expect(rowTapSwitch(null, block(sw()))).toBeNull();
  });
});

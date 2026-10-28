import { describe, expect, it } from "vitest";
import { BUTTON_SIZES, buttonClass } from "./button";

describe("buttonClass", () => {
  it("gives each size one fixed height", () => {
    expect(BUTTON_SIZES.sm).toMatch(/\bh-8\b/);
    expect(BUTTON_SIZES.md).toMatch(/\bh-9\b/);
    expect(BUTTON_SIZES.touch).toMatch(/\bh-11\b/);
  });

  it("sets the primary in semibold on the accent, everything else in medium", () => {
    expect(buttonClass("primary")).toMatch(/\bbg-accent\b.*\bfont-semibold\b.*\btext-on-accent\b/);
    for (const variant of ["secondary", "ghost"] as const) {
      const value = buttonClass(variant);
      expect(value).toMatch(/\bfont-medium\b/);
      expect(value).not.toMatch(/\bbg-accent\b|\bfont-semibold\b/);
    }
  });

  it("uses the control radius and never restates padding twice", () => {
    for (const variant of ["primary", "secondary", "ghost", "danger"] as const) {
      for (const size of ["sm", "md", "touch"] as const) {
        const value = buttonClass(variant, size);
        expect(value).toMatch(/\brounded-ctl\b/);
        expect(value.match(/(?:^|\s)px-/g)?.length).toBe(1);
        expect(value.match(/(?:^|\s)h-/g)?.length).toBe(1);
      }
    }
  });

  it("recolours only the label for a danger tone", () => {
    const value = buttonClass("secondary", "sm", "", { tone: "danger" });
    expect(value).toMatch(/\btext-danger\b/);
    expect(value).not.toMatch(/\btext-ink-body\b/);
  });
});

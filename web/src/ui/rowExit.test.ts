import { describe, expect, it } from "vitest";
import { ROW_EXIT_MS, exitRows, rowExitAllowed, rowExitKeyframes } from "./rowExit";

describe("row exit", () => {
  it("is short and eased: a fade with a small slide", () => {
    expect(ROW_EXIT_MS).toBeGreaterThanOrEqual(120);
    expect(ROW_EXIT_MS).toBeLessThanOrEqual(220);
    const [from, to] = rowExitKeyframes();
    expect(from).toMatchObject({ opacity: 1 });
    expect(to).toMatchObject({ opacity: 0 });
  });
  it("only runs for a row on screen, and never under reduced motion", () => {
    const rect = { top: 100, bottom: 152, height: 52 };
    expect(rowExitAllowed(false, rect, 900)).toBe(true);
    expect(rowExitAllowed(true, rect, 900)).toBe(false);
    expect(rowExitAllowed(false, null, 900)).toBe(false);
    expect(rowExitAllowed(false, { top: 950, bottom: 1000, height: 50 }, 900)).toBe(false);
  });
  it("still removes the rows where there is no DOM to animate", () => {
    let removed = 0;
    exitRows([1, 2], () => (removed += 1));
    expect(removed).toBe(1);
  });
});

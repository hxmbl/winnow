import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIT_TOLERANCE_PX, MIN_FIT_SCALE, fitScale, overflowAfterFit } from "./emailFit";

describe("fitScale", () => {
  it("leaves a message that fits at 1 (responsive mail is untouched)", () => {
    expect(fitScale(292, 292)).toBe(1);
    expect(fitScale(200, 292)).toBe(1);
    expect(fitScale(292 + FIT_TOLERANCE_PX, 292)).toBe(1);
  });
  it("shrinks a 640px fixed-width newsletter to a phone card, never overshooting", () => {
    const scale = fitScale(640, 306);
    expect(scale).toBeLessThan(1);
    expect(640 * scale).toBeLessThanOrEqual(306);
    expect(306 - 640 * scale).toBeLessThan(7);
  });
  it("shrinks on a narrow desktop pane too", () => {
    expect(fitScale(640, 520)).toBeCloseTo(0.81, 2);
  });
  it("stops at the smallest legible scale, and then the rest scrolls", () => {
    expect(fitScale(1400, 300)).toBe(MIN_FIT_SCALE);
    expect(overflowAfterFit(1400, 300, MIN_FIT_SCALE)).toBe(true);
    expect(overflowAfterFit(640, 306, fitScale(640, 306))).toBe(false);
    expect(overflowAfterFit(200, 300, 1)).toBe(false);
  });
  it("answers 1 for nonsense measurements (an unmounted or hidden card)", () => {
    expect(fitScale(640, 0)).toBe(1);
    expect(fitScale(Number.NaN, 300)).toBe(1);
    expect(fitScale(0, 300)).toBe(1);
  });
});

describe("the reader wires it", () => {
  const body = readFileSync(new URL("./components/MessageBody.tsx", import.meta.url), "utf8");
  it("the rich body zooms its container with fitScale, rather than cutting it off", () => {
    expect(body).toMatch(/useFitToWidth\(containerRef, html( \+ senderCss)?\)/);
    expect(body).toMatch(/el\.style\.zoom = String\(scale\)/);
    expect(body).toMatch(/ResizeObserver/);
  });
});

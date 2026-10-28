import { describe, expect, it } from "vitest";
import {
  KEY_SCROLL_DURATION,
  KEY_SCROLL_STEP,
  clamp,
  easeOutCubic,
  positionAt,
  retarget,
} from "./keyScroll";

describe("easeOutCubic", () => {
  it("starts at 0, ends at 1 and clamps outside", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-0.5)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });

  it("eases out: quick at first, slow at the end, never backwards", () => {
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
    // More than half the distance in the first quarter.
    expect(easeOutCubic(0.25)).toBeGreaterThan(0.5);
    let last = 0;
    for (let i = 1; i <= 20; i += 1) {
      const v = easeOutCubic(i / 20);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
});

describe("clamp", () => {
  it("keeps a value inside the range", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(7, 0, 10)).toBe(7);
  });
});

describe("retarget", () => {
  it("keeps the step distance and the chosen curve length", () => {
    expect(KEY_SCROLL_STEP).toBe(120);
    expect(KEY_SCROLL_DURATION).toBeGreaterThanOrEqual(120);
    expect(KEY_SCROLL_DURATION).toBeLessThanOrEqual(180);
  });

  it("starts a glide from where the content is", () => {
    const glide = retarget(null, 300, 120, 1000, 5000, false);
    expect(glide).toEqual({ from: 300, to: 420, start: 1000, duration: KEY_SCROLL_DURATION });
  });

  it("adds a press to the distance still to go instead of restarting", () => {
    const first = retarget(null, 0, 120, 0, 5000, false);
    // Halfway through, a second press: the target moves on by a step from the old
    // target, and the curve picks up from where the content is now.
    const mid = positionAt(first, KEY_SCROLL_DURATION / 2).top;
    const second = retarget(first, mid, 120, KEY_SCROLL_DURATION / 2, 5000, false);
    expect(second.to).toBe(240);
    expect(second.from).toBe(mid);
    expect(positionAt(second, KEY_SCROLL_DURATION / 2).top).toBe(mid);
  });

  it("accumulates a held key's repeats", () => {
    let glide = retarget(null, 0, 120, 0, 10_000, false);
    for (let i = 1; i <= 9; i += 1) {
      const now = i * 33;
      glide = retarget(glide, positionAt(glide, now).top, 120, now, 10_000, false);
    }
    expect(glide.to).toBe(1200);
  });

  it("lets a press the other way cancel out", () => {
    const down = retarget(null, 500, 120, 0, 5000, false);
    const up = retarget(down, positionAt(down, 40).top, -120, 40, 5000, false);
    expect(up.to).toBe(500);
  });

  it("clamps at the top and the bottom", () => {
    expect(retarget(null, 50, -120, 0, 5000, false).to).toBe(0);
    expect(retarget(null, 4950, 120, 0, 5000, false).to).toBe(5000);
    // Pressing on past the bottom does not bank distance to scroll back through.
    let glide = retarget(null, 4900, 120, 0, 5000, false);
    glide = retarget(glide, 4950, 120, 10, 5000, false);
    glide = retarget(glide, 4990, 120, 20, 5000, false);
    expect(glide.to).toBe(5000);
    expect(retarget(glide, 5000, -120, 30, 5000, false).to).toBe(4880);
  });

  it("treats a body that fits as having nowhere to go", () => {
    expect(retarget(null, 0, 120, 0, -20, false).to).toBe(0);
  });

  it("lands at once under reduced motion", () => {
    const glide = retarget(null, 100, 120, 0, 5000, true);
    expect(glide.duration).toBe(0);
    expect(positionAt(glide, 0)).toEqual({ top: 220, done: true });
  });
});

describe("positionAt", () => {
  it("follows the curve and arrives on time", () => {
    const glide = retarget(null, 0, 120, 0, 5000, false);
    expect(positionAt(glide, 0)).toEqual({ top: 0, done: false });
    expect(positionAt(glide, KEY_SCROLL_DURATION / 2).top).toBeCloseTo(105);
    expect(positionAt(glide, KEY_SCROLL_DURATION)).toEqual({ top: 120, done: true });
    expect(positionAt(glide, KEY_SCROLL_DURATION * 3)).toEqual({ top: 120, done: true });
  });

  it("goes up as smoothly as down", () => {
    const glide = retarget(null, 600, -120, 0, 5000, false);
    expect(positionAt(glide, KEY_SCROLL_DURATION / 2).top).toBeCloseTo(495);
  });
});

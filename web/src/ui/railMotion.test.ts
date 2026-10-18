import { describe, expect, it } from "vitest";
import {
  BLUR_MAX,
  RUBBER_MAX,
  SPRING_BACK_MS,
  blurForVelocity,
  nextVelocity,
  rubberBand,
  smoothStep,
  splitOvershoot,
  springBack,
  wheelDelta,
} from "./railMotion";

describe("smoothStep", () => {
  it("closes part of the distance each frame and lands exactly", () => {
    let x = 0;
    const seen: number[] = [];
    for (let i = 0; i < 60 && x !== 300; i += 1) {
      x = smoothStep(x, 300, 16.67);
      seen.push(x);
    }
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThan(150);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1]!)).toBe(true);
    expect(x).toBe(300);
  });
  it("is frame-rate independent", () => {
    const one = smoothStep(0, 100, 16.67);
    const two = smoothStep(smoothStep(0, 100, 8.335), 100, 8.335);
    expect(Math.abs(one - two)).toBeLessThan(0.01);
  });
  it("never overshoots, either way", () => {
    expect(smoothStep(100, 0, 1000)).toBeGreaterThanOrEqual(0);
    expect(smoothStep(0, -50, 16)).toBeLessThan(0);
    expect(smoothStep(0, -50, 16)).toBeGreaterThanOrEqual(-50);
  });
});

describe("rubberBand", () => {
  it("is nearly linear for a small pull and damped for a long one", () => {
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(10)).toBeGreaterThan(4);
    expect(rubberBand(200)).toBeLessThan(2 * rubberBand(100));
    expect(rubberBand(-40)).toBe(-rubberBand(40));
  });
  it("never reaches its limit", () => {
    expect(rubberBand(100_000)).toBeLessThan(RUBBER_MAX);
  });
});

describe("springBack", () => {
  it("eases from the overshoot to exactly zero", () => {
    expect(springBack(40, 0)).toBe(40);
    expect(springBack(40, SPRING_BACK_MS / 2)).toBeLessThan(20);
    expect(springBack(40, SPRING_BACK_MS)).toBe(0);
  });
});

describe("splitOvershoot", () => {
  it("clamps the scroll and keeps what was past the end", () => {
    expect(splitOvershoot(-30, 500)).toEqual({ scroll: 0, overshoot: -30 });
    expect(splitOvershoot(530, 500)).toEqual({ scroll: 500, overshoot: 30 });
    expect(splitOvershoot(200, 500)).toEqual({ scroll: 200, overshoot: 0 });
    expect(splitOvershoot(10, -5)).toEqual({ scroll: 0, overshoot: 10 });
  });
});

describe("blurForVelocity", () => {
  it("is crisp at rest and at a slow scroll", () => {
    expect(blurForVelocity(0)).toBe(0);
    expect(blurForVelocity(0.3)).toBe(0);
    expect(blurForVelocity(Number.NaN)).toBe(0);
  });
  it("grows with speed, either direction, capped and subtle", () => {
    expect(blurForVelocity(2)).toBeGreaterThan(0);
    expect(blurForVelocity(-2)).toBe(blurForVelocity(2));
    expect(blurForVelocity(50)).toBe(BLUR_MAX);
    expect(BLUR_MAX).toBeLessThanOrEqual(1);
  });
});

describe("nextVelocity", () => {
  it("smooths one uneven reading and ignores a zero-length frame", () => {
    expect(nextVelocity(0, 160, 16)).toBeCloseTo(6, 5);
    expect(nextVelocity(2, 10, 0)).toBe(2);
  });
});

describe("wheelDelta", () => {
  it("takes whichever axis moved most, so a vertical wheel scrolls the strip sideways", () => {
    expect(wheelDelta(0, 120, 0, 600)).toBe(120);
    expect(wheelDelta(-30, 4, 0, 600)).toBe(-30);
    expect(wheelDelta(0, 3, 1, 600)).toBe(48);
  });
});

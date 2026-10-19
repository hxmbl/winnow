import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUBBER_MAX,
  SPRING_BACK_MS,
  glideDone,
  glideFrom,
  rubberBand,
  smoothStep,
  splitOvershoot,
  springBack,
  wheelDelta,
} from "./railMotion";

const here = path.dirname(fileURLToPath(import.meta.url));

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

describe("no motion blur (1.3.3)", () => {
  it("the strip's motion module exports nothing scroll-speed linked", async () => {
    const mod: Record<string, unknown> = await import("./railMotion");
    expect(Object.keys(mod).filter((k) => /blur|velocity/i.test(k))).toEqual([]);
  });
  it("no stylesheet rule or hook filters the chips while the list scrolls", () => {
    const css = readFileSync(path.join(here, "../index.css"), "utf8");
    expect(css).not.toMatch(/data-rail-moving|--wn-rail-blur/);
    const hook = readFileSync(path.join(here, "components/useRailMotion.ts"), "utf8");
    expect(hook).not.toMatch(/addEventListener\("scroll"|--wn-rail-blur|railMoving/);
  });
});

describe("wheelDelta", () => {
  it("takes whichever axis moved most, so a vertical wheel scrolls the strip sideways", () => {
    expect(wheelDelta(0, 120, 0, 600)).toBe(120);
    expect(wheelDelta(-30, 4, 0, 600)).toBe(-30);
    expect(wheelDelta(0, 3, 1, 600)).toBe(48);
  });
});

describe("glideFrom", () => {
  it("starts from the strip when no glide is in flight", () => {
    expect(glideFrom(null, 0, 200)).toBe(200);
  });
  it("adds notches onto an in-flight glide's target", () => {
    // The glide last left the strip at 380 on its way to 500: the next notch builds on 500.
    expect(glideFrom(500, 380, 380)).toBe(500);
    // scrollLeft snapping to a device pixel is still the glide's own write.
    expect(glideFrom(500, 380.4, 380)).toBe(500);
  });
  it("drops a stale target when something else scrolled the strip mid-glide", () => {
    // Mid-glide to 500 the strip was moved to 200 (focus, a scrollbar, code): go on from 200,
    // not from 500, or the next notch lands far past where it should.
    expect(glideFrom(500, 380, 200)).toBe(200);
    expect(glideFrom(500, 380, 0)).toBe(0);
  });
});

describe("smoothStep on slow frames", () => {
  it("a long frame closes more of the distance but never passes the target", () => {
    for (const dt of [16.67, 100, 250, 1000]) {
      const x = smoothStep(200, 440, dt);
      expect(x).toBeGreaterThan(200);
      expect(x).toBeLessThanOrEqual(440);
    }
  });
});

describe("glideDone", () => {
  /** A glide as useRailMotion runs it, against a browser that snaps scrollLeft with `snap`. */
  const run = (from: number, target: number, snap: (x: number) => number, dt = 16.67) => {
    let x = from;
    for (let frame = 1; frame <= 200; frame += 1) {
      const before = x;
      x = snap(smoothStep(before, target, dt));
      if (glideDone(target, before, x)) return { frames: frame, at: snap(target) };
    }
    return { frames: Infinity, at: x };
  };
  it("ends where scrollLeft snaps down to whole pixels (it used to stop a pixel short, for ever)", () => {
    for (const [from, target] of [[200, 440], [0, 300], [300, 500], [440, 200]] as const) {
      const done = run(from, target, Math.floor);
      expect(done.frames).toBeLessThan(40);
      expect(done.at).toBe(target);
    }
  });
  it("ends with rounding or fractional scrollLeft too, on fast and slow frames", () => {
    for (const snap of [Math.round, (x: number) => x]) {
      for (const dt of [8.33, 16.67, 100]) {
        const done = run(200, 440, snap, dt);
        expect(done.frames).toBeLessThan(80);
        expect(done.at).toBe(440);
      }
    }
  });
  it("keeps going while a frame still makes progress", () => {
    expect(glideDone(440, 200, 267)).toBe(false);
    expect(glideDone(440, 437, 438)).toBe(false);
    expect(glideDone(440, 438, 439)).toBe(true);
    expect(glideDone(440, 439, 439)).toBe(true);
  });
});

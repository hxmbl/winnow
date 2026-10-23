import { describe, expect, it } from "vitest";
import {
  END_GIVE_PX,
  FOLLOW_MAX_PX,
  PillSwipe,
  STEP_COMMIT_PX,
  STEP_FLING_MIN_PX,
  canTake,
  pillShift,
  releaseStep,
  stepFor,
} from "./readerSwipe";
import { AXIS_LOCK_PX, EDGE_PX } from "./swipe";

const BOTH = { prev: true, next: true };
const TOUCH = { pointerType: "touch", buttons: 1 };
const SCREEN = { screenWidth: 390, pointer: TOUCH };

describe("stepFor: the masthead arrows' meaning", () => {
  it("a swipe left is next (+1, the older message below)", () => {
    expect(stepFor(-80)).toBe(1);
  });
  it("a swipe right is previous (-1, the newer message above)", () => {
    expect(stepFor(80)).toBe(-1);
  });
  it("no movement asks for nothing", () => {
    expect(stepFor(0)).toBeNull();
  });
});

describe("canTake / pillShift: the ends of the list", () => {
  it("only the ways the arrows could go", () => {
    expect(canTake(-80, { prev: true, next: false })).toBe(false);
    expect(canTake(80, { prev: true, next: false })).toBe(true);
    expect(canTake(80, { prev: false, next: true })).toBe(false);
  });
  it("follows the finger a little, capped", () => {
    expect(pillShift(-20, BOTH)).toBeLessThan(0);
    expect(Math.abs(pillShift(-20, BOTH))).toBeLessThan(20);
    expect(pillShift(-500, BOTH)).toBe(-FOLLOW_MAX_PX);
    expect(pillShift(500, BOTH)).toBe(FOLLOW_MAX_PX);
  });
  it("gives only a few pixels toward an end", () => {
    const atLast = { prev: true, next: false };
    expect(Math.abs(pillShift(-500, atLast))).toBe(END_GIVE_PX);
    expect(pillShift(-500, atLast)).toBeLessThan(0);
  });
});

describe("releaseStep", () => {
  it("steps past the commit line", () => {
    expect(releaseStep({ dx: -STEP_COMMIT_PX, velocity: 0, reach: BOTH })).toBe(1);
    expect(releaseStep({ dx: STEP_COMMIT_PX, velocity: 0, reach: BOTH })).toBe(-1);
  });
  it("springs back short of it without a flick", () => {
    expect(releaseStep({ dx: -(STEP_COMMIT_PX - 1), velocity: -0.1, reach: BOTH })).toBeNull();
  });
  it("a quick flick the same way steps, once it has travelled a little", () => {
    expect(releaseStep({ dx: -STEP_FLING_MIN_PX, velocity: -1, reach: BOTH })).toBe(1);
    expect(releaseStep({ dx: -(STEP_FLING_MIN_PX - 1), velocity: -1, reach: BOTH })).toBeNull();
  });
  it("flinging back toward the start cancels", () => {
    expect(releaseStep({ dx: -STEP_COMMIT_PX * 2, velocity: 1, reach: BOTH })).toBeNull();
  });
  it("does nothing at an end: no wrap", () => {
    expect(releaseStep({ dx: -200, velocity: -2, reach: { prev: true, next: false } })).toBeNull();
    expect(releaseStep({ dx: 200, velocity: 2, reach: { prev: false, next: true } })).toBeNull();
  });
});

describe("PillSwipe: a press on the pill", () => {
  /** Drive a press from (x, y) by `steps` moves of (dx, dy), 16ms apart. */
  function drag(swipe: PillSwipe, from: { x: number; y: number }, dx: number, dy: number, steps: number) {
    let last = swipe.move(from.x, from.y, 0);
    for (let i = 1; i <= steps; i += 1) last = swipe.move(from.x + dx * i, from.y + dy * i, i * 16);
    return last;
  }

  it("a tap that barely moved stays a tap", () => {
    const swipe = new PillSwipe({ x: 300, y: 800, at: 0 }, BOTH, SCREEN);
    expect(swipe.move(300 + AXIS_LOCK_PX - 2, 801, 40).phase).toBe("pending");
    expect(swipe.swiping).toBe(false);
    expect(swipe.release()).toBeNull();
  });

  it("a mostly vertical move is not a swipe, even if it later goes sideways", () => {
    const swipe = new PillSwipe({ x: 300, y: 800, at: 0 }, BOTH, SCREEN);
    expect(swipe.move(303, 780, 16).phase).toBe("ignored");
    expect(swipe.move(150, 780, 32).phase).toBe("ignored");
    expect(swipe.swiping).toBe(false);
    expect(swipe.release()).toBeNull();
  });

  it("a long swipe left steps to the next message", () => {
    const swipe = new PillSwipe({ x: 300, y: 800, at: 0 }, BOTH, SCREEN);
    const last = drag(swipe, { x: 300, y: 800 }, -12, 1, 10);
    expect(last).toMatchObject({ phase: "swiping", step: 1, possible: true });
    expect(swipe.swiping).toBe(true);
    expect(swipe.release()).toBe(1);
  });

  it("a long swipe right steps to the previous one", () => {
    const swipe = new PillSwipe({ x: 120, y: 800, at: 0 }, BOTH, SCREEN);
    drag(swipe, { x: 120, y: 800 }, 12, 0, 10);
    expect(swipe.release()).toBe(-1);
  });

  it("at the last message a swipe left resists and does nothing", () => {
    const swipe = new PillSwipe({ x: 300, y: 800, at: 0 }, { prev: true, next: false }, SCREEN);
    const last = drag(swipe, { x: 300, y: 800 }, -12, 0, 12);
    expect(last).toMatchObject({ phase: "swiping", possible: false });
    if (last.phase === "swiping") expect(Math.abs(last.shift)).toBeLessThanOrEqual(END_GIVE_PX);
    expect(swipe.release()).toBeNull();
  });

  it("a stylus tip swipes; a mouse, or a stylus with its side button held, does not", () => {
    const pen = new PillSwipe({ x: 300, y: 800, at: 0 }, BOTH, { screenWidth: 390, pointer: { pointerType: "pen", buttons: 1 } });
    drag(pen, { x: 300, y: 800 }, -12, 0, 10);
    expect(pen.release()).toBe(1);
    for (const pointer of [
      { pointerType: "mouse", buttons: 1 },
      { pointerType: "pen", buttons: 2 },
    ]) {
      const swipe = new PillSwipe({ x: 300, y: 800, at: 0 }, BOTH, { screenWidth: 390, pointer });
      expect(drag(swipe, { x: 300, y: 800 }, -12, 0, 10).phase).toBe("ignored");
      expect(swipe.release()).toBeNull();
    }
  });

  it("a press in the system edge zone is Android's back gesture, not a step", () => {
    const swipe = new PillSwipe({ x: 390 - EDGE_PX + 4, y: 800, at: 0 }, BOTH, SCREEN);
    expect(drag(swipe, { x: 390 - EDGE_PX + 4, y: 800 }, -12, 0, 10).phase).toBe("ignored");
    expect(swipe.release()).toBeNull();
  });
});

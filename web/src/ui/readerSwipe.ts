/**
 * A sideways swipe on the phone reader's action pill steps to the previous or next
 * message, as pure logic (STRM-324).
 *
 * The step is the same one the masthead's ‹ › arrows and `j`/`k` take
 * (`store.moveCursor`), so this module never walks the list itself: it only decides
 * whether a touch on the pill was a swipe, which way, and how far the pill is drawn.
 *
 *   - **Direction.** The arrows' meaning: "next" (`+1`) is the row below, the older
 *     message; "previous" (`-1`) the row above. Swiping left (finger toward the left
 *     edge) is next, as when turning a page; swiping right is previous.
 *   - **Taps stay taps.** Nothing is decided until the finger has moved `AXIS_LOCK_PX`
 *     (shared with the list's row swipes), and only a mostly sideways move is a swipe. A
 *     press that never got that far is an ordinary tap on the button under it; once a
 *     move is a swipe, that button's click is swallowed (the component does this).
 *   - **Commit.** Letting go past `STEP_COMMIT_PX`, or a quick flick of at least
 *     `STEP_FLING_MIN_PX` in the same direction, steps. Anything shorter springs back.
 *   - **Ends.** No wrap: at the first or last message the pill gives a few pixels of
 *     resistance (`END_GIVE_PX`) and letting go does nothing.
 *
 * Shares `swipe.ts`'s rules for what may swipe (a finger or a stylus tip, never a mouse
 * or a stylus with its side button held) and the system edge zones (Android's back
 * gesture).
 */

import { VelocityTracker, inEdgeZone, lockAxis, swipesWith, type Axis } from "./swipe";

/** Letting go at least this far (px) from where the finger went down steps. */
export const STEP_COMMIT_PX = 64;
/** A release at least this fast (px/ms) the same way steps, even short of the line… */
export const STEP_FLING_VELOCITY = 0.5;
/** …but only after this much travel (px), so a flick that barely moved does nothing. */
export const STEP_FLING_MIN_PX = 28;
/** The pill follows this share of the finger: a hint of motion, not a drag. */
export const FOLLOW_SHARE = 0.4;
/** And never further than this (px). */
export const FOLLOW_MAX_PX = 36;
/** At an end of the list it gives at most this much (px) before stopping. */
export const END_GIVE_PX = 8;

/** `+1` is next (older, below in the list); `-1` previous (newer, above). */
export type StepDelta = 1 | -1;

/** Which ways a step would go anywhere: from `store.canStep(-1)` and `store.canStep(1)`. */
export type StepReach = { prev: boolean; next: boolean };

/** The step a horizontal finger offset asks for: left is next, right is previous. */
export function stepFor(dx: number): StepDelta | null {
  if (dx === 0) return null;
  return dx < 0 ? 1 : -1;
}

/** Whether the step `dx` asks for would go anywhere. */
export function canTake(dx: number, reach: StepReach): boolean {
  const step = stepFor(dx);
  if (step === null) return false;
  return step === 1 ? reach.next : reach.prev;
}

/**
 * Where the pill is drawn (px along x) for a finger offset `dx`: a damped share of the
 * finger toward a message that exists, a few pixels of resistance toward an end.
 */
export function pillShift(dx: number, reach: StepReach): number {
  if (dx === 0) return 0;
  const sign = Math.sign(dx);
  const distance = Math.abs(dx);
  if (!canTake(dx, reach)) return sign * Math.min(END_GIVE_PX, distance * 0.1);
  return sign * Math.min(FOLLOW_MAX_PX, distance * FOLLOW_SHARE);
}

/**
 * What letting go does: the step to take, or null to spring back. `velocity` is px/ms
 * along x (negative is leftward). Flinging back toward the start cancels.
 */
export function releaseStep({ dx, velocity, reach }: { dx: number; velocity: number; reach: StepReach }): StepDelta | null {
  const step = stepFor(dx);
  if (step === null || !canTake(dx, reach)) return null;
  const sameWay = Math.sign(velocity) === Math.sign(dx);
  if (Math.abs(dx) >= STEP_COMMIT_PX) {
    if (!sameWay && Math.abs(velocity) >= STEP_FLING_VELOCITY) return null;
    return step;
  }
  if (sameWay && Math.abs(velocity) >= STEP_FLING_VELOCITY && Math.abs(dx) >= STEP_FLING_MIN_PX) return step;
  return null;
}

export type PillSwipeMove =
  /** Not decided yet: a tap is still possible, nothing moves. */
  | { phase: "pending" }
  /** Not a swipe (vertical, an edge, a mouse): leave it alone for the rest of the press. */
  | { phase: "ignored" }
  /** A swipe: draw the pill at `shift`. The press is no longer a tap. */
  | { phase: "swiping"; shift: number; step: StepDelta | null; possible: boolean };

/**
 * One press on the pill, from down to up. The component owns the DOM and the click
 * swallowing; this owns every decision.
 */
export class PillSwipe {
  private readonly velocity = new VelocityTracker();
  private axis: Axis = "pending";
  private dx = 0;
  private readonly ignored: boolean;

  constructor(
    private readonly start: { x: number; y: number; at: number },
    private readonly reach: StepReach,
    { screenWidth, pointer }: { screenWidth: number; pointer: { pointerType: string; buttons: number } },
  ) {
    this.ignored = !swipesWith(pointer) || inEdgeZone(start.x, screenWidth);
    this.velocity.add(start.x, start.at);
  }

  /** True once this press is a swipe (so it must not also be a tap). */
  get swiping(): boolean {
    return this.axis === "horizontal" && !this.ignored;
  }

  move(x: number, y: number, at: number): PillSwipeMove {
    if (this.ignored || this.axis === "vertical") return { phase: "ignored" };
    const dx = x - this.start.x;
    const dy = y - this.start.y;
    this.velocity.add(x, at);
    if (this.axis === "pending") {
      this.axis = lockAxis(dx, dy);
      if (this.axis === "pending") return { phase: "pending" };
      if (this.axis === "vertical") return { phase: "ignored" };
    }
    this.dx = dx;
    return { phase: "swiping", shift: pillShift(dx, this.reach), step: stepFor(dx), possible: canTake(dx, this.reach) };
  }

  /** The step to take on letting go, or null (also when this was never a swipe). */
  release(): StepDelta | null {
    if (!this.swiping) return null;
    return releaseStep({ dx: this.dx, velocity: this.velocity.velocity(), reach: this.reach });
  }
}

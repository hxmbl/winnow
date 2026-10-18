/**
 * Pull-to-refresh on the phone's list, as pure logic.
 *
 * With an account connected the phone has no briefing strip and no Sync button: a pull
 * down from the very top of the list syncs instead. The rules that keep it from fighting
 * the rows' swipes, the browser's own overscroll and everything else on screen live
 * here, with no DOM, so they are unit-tested rather than found on a real phone:
 *
 *   - **Only from the top.** A pull starts only when the list is at `scrollTop` 0 and
 *     nothing else has the screen (`pullAllowed`).
 *   - **Axis lock.** The same lock as the swipes (`swipe.ts` `lockAxis`, the same
 *     distance from the same touch start): a touch that locks horizontal is a swipe and
 *     never a pull, and one that locks vertical is a scroll or a pull and never a swipe.
 *     An upward lock is a scroll.
 *   - **Rubber band.** The indicator follows the finger at a resistance and stops at
 *     `PULL_MAX` (`pullDistance`); past `PULL_THRESHOLD` letting go syncs, and crossing
 *     it either way is a haptic tick (`crossedThreshold`).
 */

import { AXIS_LOCK_PX, lockAxis } from "./swipe";

/** How far (px, after resistance) the indicator must travel for a release to sync. */
export const PULL_THRESHOLD = 70;
/** The furthest the indicator travels, however far the finger goes. */
export const PULL_MAX = 112;
/** How much of the finger's travel the indicator follows before it starts to stiffen. */
export const PULL_RESISTANCE = 0.55;
/** How long the result ("Synced just now", or the error) stays before it retracts. */
export const PULL_RESULT_MS = 1400;

/** What decides whether a pull may start. */
export type PullContext = {
  /** An account to sync with: the demo has nothing to sync. */
  connected: boolean;
  /** The list's scroll offset when the touch began. */
  scrollTop: number;
  /** The dock's panel is expanded. */
  menuOpen: boolean;
  /** A multi-selection is under way. */
  selecting: boolean;
  /** Settings, the palette, a sheet, a menu or the composer is over the list. */
  overlay: boolean;
  /** A sync is already running. */
  syncing: boolean;
};

/** Whether a touch on the list may become a pull. */
export function pullAllowed(context: PullContext): boolean {
  return (
    context.connected &&
    context.scrollTop <= 0 &&
    !context.menuOpen &&
    !context.selecting &&
    !context.overlay &&
    !context.syncing
  );
}

/** What a touch is, once it has moved far enough to say. */
export type PullIntent = "pending" | "pull" | "swipe" | "scroll";

/**
 * Classify a touch from its travel since it began. The lock is `swipe.ts`'s, so the
 * swipe and the pull always agree: horizontal is a swipe; vertical and downward is a
 * pull; vertical and upward is an ordinary scroll.
 */
export function pullIntent(dx: number, dy: number, lock = AXIS_LOCK_PX): PullIntent {
  const axis = lockAxis(dx, dy, lock);
  if (axis === "pending") return "pending";
  if (axis === "horizontal") return "swipe";
  return dy > 0 ? "pull" : "scroll";
}

/**
 * How far the indicator has travelled for a finger `dy` px down: it follows at
 * `PULL_RESISTANCE`, then eases toward `PULL_MAX` so it never runs away. Never
 * negative; monotonic.
 */
export function pullDistance(dy: number): number {
  if (dy <= 0) return 0;
  const linear = dy * PULL_RESISTANCE;
  // Linear up to the threshold, then an exponential approach to the max.
  if (linear <= PULL_THRESHOLD) return linear;
  const room = PULL_MAX - PULL_THRESHOLD;
  return PULL_THRESHOLD + room * (1 - Math.exp(-(linear - PULL_THRESHOLD) / room));
}

/** Whether letting go at this distance syncs. */
export function pastPullThreshold(distance: number): boolean {
  return distance >= PULL_THRESHOLD;
}

/** Whether a move from `before` to `after` crossed the threshold (either way): a tick. */
export function crossedThreshold(before: number, after: number): boolean {
  return pastPullThreshold(before) !== pastPullThreshold(after);
}

/** The sync icon's turn for a distance: a full turn at the threshold. */
export function pullRotation(distance: number): number {
  return Math.round((Math.max(0, distance) / PULL_THRESHOLD) * 360);
}

/**
 * The indicator's phases. `pulling` follows the finger; `armed` is past the line;
 * `syncing` spins; `done` and `error` show the result for `PULL_RESULT_MS`; then idle.
 */
export type PullPhase = "idle" | "pulling" | "armed" | "syncing" | "done" | "error";

/** The phase while the finger is down. */
export function phaseFor(distance: number): PullPhase {
  if (distance <= 0) return "idle";
  return pastPullThreshold(distance) ? "armed" : "pulling";
}

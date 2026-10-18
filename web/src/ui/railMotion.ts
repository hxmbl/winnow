/**
 * How the filter strip moves, as numbers the tests can check without a DOM.
 *
 * Three pieces, all used by `FilterStrip`:
 *
 * - **Smoothing.** A wheel or trackpad over the strip sets a *target* scroll position;
 *   each animation frame closes a share of the distance to it (`smoothStep`), so a mouse
 *   wheel's 100px notches glide instead of jumping, and a trackpad's stream of small
 *   deltas stays as direct as it was.
 * - **Rubber band.** Past either end the strip gives a little and springs back: the
 *   overshoot is damped (`rubberBand`, the curve iOS uses), so pulling twice as far
 *   moves it much less than twice as far, and it never travels more than `RUBBER_MAX`.
 * - **Motion blur.** While the list scrolls, the strip blurs in proportion to how fast
 *   (`blurForVelocity`): nothing below a walking pace, at most `BLUR_MAX` px, and crisp
 *   again the moment the list stops.
 */

import { wheelPixels } from "./rail";

/** How much of the remaining distance a frame closes (at 60fps). */
export const SMOOTHING = 0.28;

/** Closer than this (px) to the target counts as there. */
export const SETTLE_PX = 0.5;

/**
 * One frame of the glide from `current` towards `target`, for a frame `dtMs` long.
 *
 * Frame-rate independent: two 8ms frames close the same distance as one 16ms frame, so a
 * 120Hz screen glides at the same speed as a 60Hz one, and a dropped frame catches up
 * rather than slowing the strip down.
 */
export function smoothStep(current: number, target: number, dtMs: number): number {
  const distance = target - current;
  if (Math.abs(distance) <= SETTLE_PX) return target;
  const frames = Math.max(0, Math.min(dtMs, 100)) / (1000 / 60);
  const kept = Math.pow(1 - SMOOTHING, frames);
  return target - distance * kept;
}

/**
 * Whether a glide frame that moved the strip from `before` to `after` (as read back, after
 * the browser snapped it) is the last one. Done within a pixel of `target`, or when the
 * frame made no progress at all: a browser that snaps scrollLeft down to whole pixels turns
 * every write of 439.3 into 439, so on the way to 440 the strip would otherwise sit a pixel
 * short with the glide running every frame, for ever.
 */
export function glideDone(target: number, before: number, after: number): boolean {
  return Math.abs(target - after) <= 1 || after === before;
}

/** A scroll position this far (px) from the glide's last write means someone else moved the strip. */
export const OUTSIDE_SCROLL_PX = 1;

/**
 * Where a wheel's glide starts from. While a glide is in flight (`target` set) notches add
 * up onto its target, so quick turns of the wheel travel the full distance. But if the
 * strip is no longer where the glide last put it (`written`), something else scrolled it
 * (a scrollbar drag, focus scrolling a chip into view, code), and the stale target is
 * dropped: the next notch moves on from where the strip actually is.
 */
export function glideFrom(target: number | null, written: number, current: number): number {
  if (target === null) return current;
  return Math.abs(current - written) > OUTSIDE_SCROLL_PX ? current : target;
}

/** The furthest the strip travels past an end, in px. */
export const RUBBER_MAX = 56;

/**
 * How far the strip shows past an end for `overshoot` px of pull (either sign).
 *
 * `(1 - 1 / (x * c / d + 1)) * d`: linear at first (a small pull moves it nearly as far),
 * then flattening towards `RUBBER_MAX`, which it never reaches.
 */
export function rubberBand(overshoot: number, limit: number = RUBBER_MAX): number {
  if (overshoot === 0 || limit <= 0) return 0;
  const x = Math.abs(overshoot);
  const shown = (1 - 1 / ((x * 0.55) / limit + 1)) * limit;
  return Math.sign(overshoot) * shown;
}

/** How long the strip takes to spring back from an overshoot, in ms. */
export const SPRING_BACK_MS = 220;

/**
 * Where an overshoot of `from` px stands `elapsedMs` into the spring back: an ease-out
 * cubic, so it leaves the edge quickly and settles softly, and is exactly 0 at the end.
 */
export function springBack(from: number, elapsedMs: number, durationMs: number = SPRING_BACK_MS): number {
  if (elapsedMs >= durationMs || durationMs <= 0) return 0;
  const t = Math.max(0, elapsedMs) / durationMs;
  return from * Math.pow(1 - t, 3);
}

/** Where a scroll position would be if it were not clamped, split into the two parts. */
export function splitOvershoot(wanted: number, max: number): { scroll: number; overshoot: number } {
  const top = Math.max(0, max);
  if (wanted < 0) return { scroll: 0, overshoot: wanted };
  if (wanted > top) return { scroll: top, overshoot: wanted - top };
  return { scroll: wanted, overshoot: 0 };
}

/** The strongest motion blur, in px. Subtle on purpose: the pills stay legible. */
export const BLUR_MAX = 0.9;
/** List speed (px per ms) below which there is no blur at all. ~0.6 = 600px/s. */
export const BLUR_FROM = 0.6;
/** List speed (px per ms) at which the blur is at its strongest. */
export const BLUR_FULL = 4;

/** The strip's blur, in px rounded to tenths, for a list moving at `pxPerMs` (either sign). */
export function blurForVelocity(pxPerMs: number): number {
  const speed = Math.abs(pxPerMs);
  if (!Number.isFinite(speed) || speed <= BLUR_FROM) return 0;
  const t = Math.min(1, (speed - BLUR_FROM) / (BLUR_FULL - BLUR_FROM));
  return Math.round(t * BLUR_MAX * 10) / 10;
}

/**
 * Velocity from two scroll readings, smoothed with the last estimate so one uneven frame
 * does not flash the blur on. `dtMs` of 0 (two events in one frame) keeps the last value.
 */
export function nextVelocity(previous: number, deltaPx: number, dtMs: number): number {
  if (dtMs <= 0) return previous;
  const instant = deltaPx / Math.min(dtMs, 100);
  return previous * 0.4 + instant * 0.6;
}

/**
 * The wheel's contribution to the strip, in px: whichever axis moved most, so a vertical
 * wheel scrolls the strip sideways and a trackpad's sideways swipe does too. Units as
 * `wheelPixels` (lines 16px, pages the strip's width).
 */
export function wheelDelta(deltaX: number, deltaY: number, deltaMode: number, pageWidth: number): number {
  const delta = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY;
  return wheelPixels(delta, deltaMode, pageWidth);
}

/**
 * How the filter strip moves, as numbers the tests can check without a DOM.
 *
 * Two pieces, both used by `FilterStrip`:
 *
 * - **Smoothing.** A wheel or trackpad over the strip sets a *target* scroll position;
 *   each animation frame closes a share of the distance to it (`smoothStep`), so a mouse
 *   wheel's 100px notches glide instead of jumping, and a trackpad's stream of small
 *   deltas stays as direct as it was.
 * - **Rubber band.** Past either end the strip gives a little and springs back: the
 *   overshoot is damped (`rubberBand`, the curve iOS uses), so pulling twice as far
 *   moves it much less than twice as far, and it never travels more than `RUBBER_MAX`.
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

/**
 * The wheel's contribution to the strip, in px: whichever axis moved most, so a vertical
 * wheel scrolls the strip sideways and a trackpad's sideways swipe does too. Units as
 * `wheelPixels` (lines 16px, pages the strip's width).
 */
export function wheelDelta(deltaX: number, deltaY: number, deltaMode: number, pageWidth: number): number {
  const delta = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY;
  return wheelPixels(delta, deltaMode, pageWidth);
}

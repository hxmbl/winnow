/**
 * The list's half of a smart-filter (or mailbox) switch, as numbers and decisions.
 *
 * Tapping a chip used to swap the list in one frame: every row you were looking at gone,
 * a different set in its place, with nothing to say which rows had stayed. Now the switch
 * reads as one motion, in three parts that overlap:
 *
 *   leave  rows that are not in the new view fade out where they stood (with a 2px blur,
 *          so they read as receding rather than as a flicker), the top one first;
 *   move   rows in both views slide from where they were to where they now are (FLIP:
 *          measured before and after, then played back from the old place);
 *   enter  rows new to the view fade in, a few milliseconds apart down the screen.
 *
 * Fast on purpose, under the app's rule that nothing runs much past 220ms (the note on
 * `animation` in `index.css`): leaving is 130ms, the slide 200ms after a 20ms
 * beat, and the last row to arrive is in by 250ms. Only what is on screen moves; the list
 * is windowed, and rows outside the window are not in the DOM at all.
 *
 * The DOM side (snapshot, ghosts, Web Animations) is `useFilterSwitchMotion`. This file
 * holds the parts with no DOM in them, which are the parts worth testing.
 */

/** How long a leaving row takes to fade out, in ms. */
export const SWITCH_LEAVE_MS = 130;
/** Between one leaving row and the next, top to bottom. */
export const SWITCH_LEAVE_STEP_MS = 8;
/** The most the leaving stagger spreads, so a full screen of leavers is gone by ~170ms. */
export const SWITCH_LEAVE_SPREAD_MS = 40;
/** Ease-in: a leaving row is going, so it speeds up as it goes. */
export const SWITCH_LEAVE_EASING = "cubic-bezier(0.4, 0, 1, 1)";

/** A staying row's slide to its new place. */
export const SWITCH_MOVE_MS = 200;
/**
 * A beat before the slide, so the gap a leaving row opens is seen before it closes (the
 * mockup's "then close the gaps"), without waiting out the whole fade.
 */
export const SWITCH_MOVE_DELAY_MS = 20;
/** Decelerating: the row arrives and settles rather than stopping dead. */
export const SWITCH_MOVE_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/** A new row's fade in. */
export const SWITCH_ENTER_MS = 140;
/** When the first new row starts, once the leavers have begun to clear its spot. */
export const SWITCH_ENTER_DELAY_MS = 30;
/** Between one new row and the next. */
export const SWITCH_ENTER_STEP_MS = 16;
export const SWITCH_ENTER_EASING = "cubic-bezier(0, 0, 0.2, 1)";

/** The most any one stagger step may be, whatever a caller asks for. */
export const MAX_STAGGER_STEP_MS = 20;
/** Everything in a switch is finished by this, from the frame the new list is drawn. */
export const SWITCH_TOTAL_MS = 250;

/**
 * A snapshot older than this is not played. It is taken in the render that switches the
 * view and played once the list's window has caught up (a commit or two later, before
 * paint); one still pending after this long belongs to a switch that never drew and would
 * animate some later, unrelated update.
 */
export const SWITCH_SNAPSHOT_TTL_MS = 200;

/** An item's box on screen, by its list key. */
export type ItemBox = { key: string; top: number; bottom: number };

/** The band of the scroller rows can be seen in: under any floating chrome, above the bottom. */
export type Band = { top: number; bottom: number };

/**
 * Whether a change of view gets the switch motion at all.
 *
 * Only a real switch (a previous view, and a different one); never under reduced motion;
 * never while the list is not on screen (the phone's reader covers it, or the tab is in
 * the background, where a finish event can be held for seconds); and never where the
 * browser has no Web Animations (jsdom), which is the whole technique.
 */
export function shouldAnimateSwitch(input: {
  previous: string | null;
  next: string;
  reducedMotion: boolean;
  listShown: boolean;
  canAnimate: boolean;
}): boolean {
  const { previous, next, reducedMotion, listShown, canAnimate } = input;
  if (previous === null || previous === next) return false;
  return !reducedMotion && listShown && canAnimate;
}

/** Whether any part of `box` is inside `band`. */
export function inBand(box: { top: number; bottom: number }, band: Band): boolean {
  return box.bottom > band.top && box.top < band.bottom && box.bottom > box.top;
}

/**
 * Delays for `count` staggered items, in order: `base`, then `step` more for each, the
 * step held to `MAX_STAGGER_STEP_MS`, and no delay so late that `duration` would run past
 * `cap` (or past `base + spread`, when a spread is given). Later items share the last
 * slot rather than pushing the motion out: a long list arrives as fast as a short one.
 */
export function staggerDelays(
  count: number,
  { base = 0, step, duration, cap = SWITCH_TOTAL_MS, spread = Infinity }: {
    base?: number;
    step: number;
    duration: number;
    cap?: number;
    spread?: number;
  },
): number[] {
  const each = Math.max(0, Math.min(step, MAX_STAGGER_STEP_MS));
  const latest = Math.max(0, Math.min(cap - duration, base + spread));
  const delays: number[] = [];
  for (let i = 0; i < count; i += 1) delays.push(Math.max(0, Math.min(base + i * each, latest)));
  return delays;
}

/** What happens to one item mounted after the switch. */
export type Arrival = { kind: "still" } | { kind: "move"; from: number } | { kind: "enter" };

/**
 * How an item that is in the new list's window arrives.
 *
 * `before` is its top on screen before the switch, if it was mounted then. A row that
 * was there slides by the difference, unless it is less than half a pixel (still) or more
 * than a screen (it would streak across the whole list in 200ms, which reads as a glitch
 * rather than as the same row: it fades in like a new one). A row that was not there, or
 * was but off screen and stays off screen, is new to the eye: it fades in if it can be
 * seen, and is left alone otherwise.
 */
export function arrival(before: number | undefined, after: ItemBox, band: Band): Arrival {
  const visible = inBand(after, band);
  if (before === undefined) return visible ? { kind: "enter" } : { kind: "still" };
  const delta = before - after.top;
  if (Math.abs(delta) < 0.5) return { kind: "still" };
  const height = after.bottom - after.top;
  const wasVisible = inBand({ top: before, bottom: before + height }, band);
  if (!wasVisible && !visible) return { kind: "still" };
  if (Math.abs(delta) > band.bottom - band.top) return visible ? { kind: "enter" } : { kind: "still" };
  return { kind: "move", from: delta };
}

/**
 * The rows that leave: on screen before the switch, and not mounted after it. A row still
 * in the list but now outside the window has left the screen just the same, so it is
 * judged by what is mounted, not by what the list holds. In order down the screen, which
 * is the order of the stagger.
 */
export function leavers(before: readonly ItemBox[], mountedAfter: ReadonlySet<string>, band: Band): ItemBox[] {
  return before
    .filter((box) => !mountedAfter.has(box.key) && inBand(box, band))
    .sort((a, b) => a.top - b.top);
}

/** A leaving row: fades out in place, and blurs a touch as it goes. */
export function leaveKeyframes(): Keyframe[] {
  return [
    { opacity: 1, filter: "blur(0px)" },
    { opacity: 0, filter: "blur(2px)" },
  ];
}

/** A staying row: from where it was (`from` px above or below) to where it is. */
export function moveKeyframes(from: number): Keyframe[] {
  return [{ transform: `translateY(${from}px)` }, { transform: "translateY(0)" }];
}

/** A new row: a fade, with the 4px rise the reader's `appear` uses. */
export function enterKeyframes(): Keyframe[] {
  return [
    { opacity: 0, transform: "translateY(4px)" },
    { opacity: 1, transform: "translateY(0)" },
  ];
}

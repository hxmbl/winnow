/**
 * The phone reader's floating action pill, as data: which actions, in which order, and
 * when it folds away.
 *
 * The pill floats at the bottom corner under the thumb (bottom-right, or bottom-left in
 * the left-handed layout) instead of a full-width bar. Its actions are ordered by
 * reach: the ones used most sit nearest the thumb (Archive, then Delete, then Reply),
 * Forward next, and More — the rare ones — furthest away. Back is not on it: the top of
 * the reader has a Back button, and Android has its back gesture.
 *
 * While you read down a message it folds to one small circle (a ••• handle that only
 * opens it, so a resting thumb cannot archive anything), and it opens again when you
 * scroll back up, tap the handle, or reach the end of the message. Pure, so the rules
 * are unit-tested without a DOM.
 */

export type ReaderPillAction = "archive" | "trash" | "reply" | "forward" | "more";

/** Most-used first: the order away from the thumb. */
export const REACH_ORDER: readonly ReaderPillAction[] = ["archive", "trash", "reply", "forward", "more"];

/**
 * The actions left to right on screen. Right-handed, the thumb is at the right edge, so
 * the most-used action is last; left-handed it is first.
 */
export function pillOrder(leftHanded: boolean): ReaderPillAction[] {
  return leftHanded ? [...REACH_ORDER] : [...REACH_ORDER].reverse();
}

/** How far the reader must scroll one way before the pill changes, px (no flicker on jitter). */
export const FOLD_THRESHOLD = 24;
/** Within this of the end of the message counts as the end, px. */
export const END_SLACK = 24;

export type PillScroll = {
  /** Folded to the handle. */
  collapsed: boolean;
  /** Where the current run of scrolling in one direction began. */
  anchor: number;
  /** The last scroll position seen. */
  last: number;
};

export const PILL_START: PillScroll = { collapsed: false, anchor: 0, last: 0 };

/**
 * The pill after a scroll to `top` (of a scroller `max` px long, `max = scrollHeight -
 * clientHeight`): reading down folds it once the run passes `FOLD_THRESHOLD`; scrolling
 * up the same distance opens it; the very top and the end of the message open it.
 */
export function pillAfterScroll(state: PillScroll, top: number, max: number): PillScroll {
  const atTop = top <= 0;
  const atEnd = max > 0 && top >= max - END_SLACK;
  const direction = Math.sign(top - state.last);
  const previous = Math.sign(state.last - state.anchor);
  // A change of direction starts a new run from where it turned.
  const anchor = direction !== 0 && previous !== 0 && direction !== previous ? state.last : state.anchor;
  let collapsed = state.collapsed;
  if (atTop || atEnd) collapsed = false;
  else if (top - anchor >= FOLD_THRESHOLD) collapsed = true;
  else if (anchor - top >= FOLD_THRESHOLD) collapsed = false;
  return { collapsed, anchor: collapsed !== state.collapsed ? top : anchor, last: top };
}

/** Opened by a tap on the handle: stays open until the next run down. */
export function pillOpened(state: PillScroll): PillScroll {
  return { collapsed: false, anchor: state.last, last: state.last };
}

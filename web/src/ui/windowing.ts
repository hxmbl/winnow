/**
 * Windowing arithmetic for a variable-height list.
 *
 * Split out from `MessageList` because the arithmetic is the part with no DOM in
 * it and therefore the part worth testing directly: the component around it is
 * layout and event handling, this is the part that has to be *right*.
 *
 * ## Why measured rather than fixed
 *
 * A row's height is not a constant. It carries a preview line when the message
 * has a body and an indicator row when the classifier found something to say, so
 * a real row is somewhere between 53px and 82px — a 55% spread. A fixed-height
 * virtualiser over a list like that either overlaps rows or leaves gaps, so the
 * heights are measured as they render and unmeasured items are assumed to be the
 * estimate below. The estimate only has to be close: every rendered row corrects
 * its own entry, and an item's offset is the sum of the entries before it.
 *
 * `css-behavior` on the estimate is deliberate — an assumed height must not be
 * animatable, or the scrollbar would jitter on every correction.
 */

/** A row's typical height, from the layout: 18.2px lines, 32px avatar, 16px padding. */
export const ESTIMATED_ROW_HEIGHT = 68;

/** A day header's height: `pt-4` + label line + `pb-1.5`. */
export const ESTIMATED_HEADER_HEIGHT = 40;

/** How many items to keep mounted beyond the viewport, each way. */
export const OVERSCAN = 6;

/**
 * Prefix sums of item heights, so `offsets[i]` is the top of item `i` and
 * `offsets[count]` is the total.
 *
 * `measured[i]` is `null` for an item that has not been rendered yet, and falls
 * back to `estimate(i)`.
 */
export function computeOffsets(
  count: number,
  measured: readonly (number | null)[],
  estimate: (index: number) => number = () => ESTIMATED_ROW_HEIGHT,
): Float64Array {
  const offsets = new Float64Array(count + 1);
  for (let i = 0; i < count; i += 1) {
    const height = measured[i];
    offsets[i + 1] = offsets[i]! + (height != null && height > 0 ? height : estimate(i));
  }
  return offsets;
}

/**
 * The index of the item containing `y` — the largest `i` with `offsets[i] <= y`.
 *
 * Binary search: called once per scroll frame, over a list that can be tens of
 * thousands of items long. Clamped to the last item, so scrolling past the end of
 * the content returns a valid index rather than running off the array.
 */
export function indexAt(offsets: Float64Array, y: number): number {
  const last = offsets.length - 2;
  if (last < 0) return 0;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    // `offsets[mid] <= y` — the item's *top* is at or above the point, which is what
    // makes `mid` a candidate. Testing `offsets[mid + 1]` instead finds the item
    // that has already scrolled past, which is off by one at every boundary.
    if (offsets[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The window of items to mount for a given scroll position. */
export function visibleRange(
  offsets: Float64Array,
  scrollTop: number,
  viewportHeight: number,
  overscan = OVERSCAN,
): { start: number; end: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  const first = indexAt(offsets, Math.max(0, scrollTop));
  // `+ 1` so a viewport boundary landing exactly on an item edge still mounts it,
  // and the extra one is the partial row at the bottom of the screen.
  const last = indexAt(offsets, Math.max(0, scrollTop + viewportHeight)) + 1;
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, last + overscan),
  };
}

/**
 * The scroll top that puts `index` at the top of the viewport.
 *
 * Clamped to the scrollable range, because a cursor near the end of a long list
 * cannot be scrolled to the top without running past the end of the content —
 * `scrollIntoView` handles this, and a bare assignment does not.
 */
export function scrollTopForIndex(
  offsets: Float64Array,
  index: number,
  viewportHeight: number,
): number {
  const count = offsets.length - 1;
  const total = offsets[count] ?? 0;
  const target = offsets[Math.min(Math.max(index, 0), Math.max(count - 1, 0))] ?? 0;
  return Math.min(Math.max(target, 0), Math.max(total - viewportHeight, 0));
}
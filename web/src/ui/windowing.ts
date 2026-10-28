/**
 * Windowing arithmetic for a variable-height list.
 *
 * Split out from `MessageList` because the arithmetic is the part with no DOM in it and
 * therefore the part worth testing directly; the component around it is layout and event
 * handling.
 *
 * A row's height is not a constant — 53px to 82px, depending on preview line and
 * indicator row — so a fixed-height virtualiser would overlap rows or leave gaps. Heights
 * are measured as they render; unmeasured items assume the estimate below, and every
 * rendered row corrects its own entry, since an item's offset is the sum of the entries
 * before it.
 *
 * `css-behavior` on the estimate is deliberate — an assumed height must not be
 * animatable, or the scrollbar would jitter on every correction.
 */

/** A row's typical height, from the layout: two 18.2px lines, 32px avatar, 16px padding. */
export const ESTIMATED_ROW_HEIGHT = 53;

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
/**
 * The scroll top that brings a row into view under chrome floating over the top of the
 * scroller: the row's top just below the `covered` band, clamped to the scrollable range.
 *
 * `rowTop` is in scroller coordinates (lead and padding included), unlike
 * `scrollTopForIndex`, which works in item offsets: under floating chrome the list's
 * content does not start at the scroller's top.
 */
export function revealScrollTop(rowTop: number, covered: number, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(scrollHeight - clientHeight, 0);
  return Math.min(Math.max(rowTop - covered, 0), max);
}

/**
 * How far the scroller must move for a row to be seen, given where the row sits relative
 * to the viewport's top (`top` / `bottom`, in px): negative scrolls up so it clears the
 * `covered` band under floating chrome, positive scrolls down so its bottom is on
 * screen (but never so far its top goes under the band), 0 when it is already in view.
 */
export function rowClearance(top: number, bottom: number, covered: number, clientHeight: number): number {
  if (top < covered) return top - covered;
  if (bottom > clientHeight) return Math.min(bottom - clientHeight, top - covered);
  return 0;
}

/**
 * The scroll top that brings row `rowIndex` into view, or null when it already is.
 *
 * `base` is where the list is judged from: the destination of a glide in flight, or the
 * scroll top when still. Judging from the destination is what lets `j` pressed mid-glide
 * aim for the next row instead of re-revealing the one already on its way.
 * `block: "nearest"` semantics for the in-view test; an off-screen row goes to the top,
 * below the covered band when there is floating chrome (`contentTop > 0`).
 */
export function revealTarget(
  offsets: Float64Array,
  rowIndex: number,
  base: number,
  view: { contentTop: number; coveredTop: number; clientHeight: number; scrollHeight: number },
): number | null {
  const { contentTop, coveredTop, clientHeight, scrollHeight } = view;
  const rowTop = contentTop + (offsets[rowIndex] ?? 0);
  const rowBottom = contentTop + (offsets[rowIndex + 1] ?? 0);
  if (rowTop >= base + coveredTop && rowBottom <= base + clientHeight) return null;
  return contentTop > 0
    ? revealScrollTop(rowTop, coveredTop, scrollHeight, clientHeight)
    : scrollTopForIndex(offsets, rowIndex, clientHeight);
}

/**
 * The index of the day header to pin at `line` (a y in content coordinates): the last
 * header at or above it, or -1 when none is. Shared by the pinned header and
 * `windowKey`, so the two cannot disagree about which header is showing.
 */
export function stickyIndex(offsets: Float64Array, isHeader: (index: number) => boolean, line: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return -1;
  for (let i = Math.min(indexAt(offsets, Math.max(0, line + 1)), count - 1); i >= 0; i -= 1) {
    if (isHeader(i)) return i;
  }
  return -1;
}

/**
 * Everything a scroll position decides about what the list draws: the mounted range and
 * the pinned header. Two positions with the same key render the same tree, so a scroll
 * that does not change it needs no React render at all — the browser moves the pixels.
 * Before, every scroll event re-rendered the list (one commit per frame while scrolling).
 */
export function windowKey(
  offsets: Float64Array,
  isHeader: (index: number) => boolean,
  scrollTop: number,
  contentTop: number,
  viewportHeight: number,
  topInset: number,
): string {
  const { start, end } = visibleRange(offsets, scrollTop - contentTop, viewportHeight);
  const line = scrollTop + topInset - contentTop;
  const sticky = contentTop > 0 && line < 0 ? -1 : stickyIndex(offsets, isHeader, line);
  return `${start}:${end}:${sticky}`;
}

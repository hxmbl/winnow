/**
 * The filter rail's data.
 *
 * `buildPills` lives here rather than in `FilterStrip.tsx` because exporting a plain
 * function from a component module breaks fast refresh — a module exporting both is
 * reloaded as a unit, so editing the component would reset the function too.
 *
 * This is also the only place that decides what the rail *contains*, which makes it
 * the natural home for the one genuinely tricky rule below.
 */

import {
  FILTER_LABELS,
  PERMANENT_FILTERS,
  type BuiltinSmartFilter,
  type FilterId,
} from "../core/model/signals";
import type { FacetCounts } from "../core/classify/filters";
import { FILTER_HUES, senderHue, type PillHue } from "./filterColors";

export type PillItem = {
  id: FilterId;
  label: string;
  /**
   * The pill's own colour, as a hue and saturation; the mode turns it into a fill
   * (`.wn-pill` in `index.css`). A bucket's comes from `FILTER_HUES`, a sender's from
   * its domain.
   */
  hue: PillHue;
  /**
   * The number on the pill: what tapping it would list (before search).
   *
   * With nothing on, how many messages in the open mailbox the bucket holds. With a
   * filter on (1.4.0) it is faceted: an off pill counts the current result it also
   * matches (what the list becomes with it added, since filters AND), an on pill the
   * current result. See `countFacets`.
   */
  count: number;
};

/** Build the rail's items from the store's ranked buckets and the counts. */
export function buildPills(
  rail: readonly BuiltinSmartFilter[],
  counts: ReadonlyMap<BuiltinSmartFilter, number>,
  topSenders: readonly string[],
  senderCounts: ReadonlyMap<string, number>,
  activeFilters: readonly FilterId[],
  /**
   * The store's faceted counts (`MailboxView.railFacets`), `null` with nothing on. They
   * replace the number shown; which pills the rail keeps is still decided by `counts`,
   * so turning a filter on dims a pill that no longer narrows anything to 0 rather than
   * taking it off the rail and moving every digit after it.
   */
  facets: FacetCounts | null = null,
): PillItem[] {
  const builtinCount = (id: BuiltinSmartFilter) => counts.get(id) ?? 0;
  const senderCount = (sender: string) => senderCounts.get(sender) ?? 0;
  const display = (pill: PillItem): PillItem => {
    if (!facets) return pill;
    const count =
      pill.id.kind === "builtin"
        ? (facets.builtin.get(pill.id.id) ?? 0)
        : (facets.senders.get(pill.id.sender.toLowerCase()) ?? 0);
    return { ...pill, count };
  };
  const buckets: PillItem[] = rail.map((id) => ({
    id: { kind: "builtin", id },
    label: FILTER_LABELS[id],
    hue: FILTER_HUES[id],
    count: builtinCount(id),
  }));

  /**
   * Sender pills, from the same engagement ranking the classifier uses, so "the people
   * I actually read" is at the top rather than being an alphabetical accident.
   *
   * An *active* sender keeps its pill. Hiding it is a trap: the pill that turns a filter
   * on then vanishes, so the only way to turn it off is "All", a keyboard shortcut, or a
   * reload. A control the pointer cannot reach is not a control.
   */
  const senders: PillItem[] = topSenders.map((sender) => ({
    id: { kind: "sender", sender },
    label: `From ${sender}`,
    hue: senderHue(sender),
    count: senderCount(sender),
  }));

  // An active sender that has dropped out of the top-N is appended rather than dropped,
  // or the pill disappears on its own as the ranking shifts beneath it — which reads as
  // the app losing state, while the filter stays applied, invisibly.
  for (const filter of activeFilters) {
    if (filter.kind !== "sender") continue;
    if (senders.some((pill) => pill.id.kind === "sender" && pill.id.sender === filter.sender)) {
      continue;
    }
    senders.push({
      id: filter,
      label: `From ${filter.sender}`,
      hue: senderHue(filter.sender),
      count: senderCount(filter.sender),
    });
  }

  // Zero-count chips (1.3.3): a pill that would show nothing and is not on goes, unless
  // it is one of the pinned pair, which keeps its place (the rail does not reshuffle
  // and the digit shortcuts do not move) and is drawn dimmed instead (`FilterStrip`,
  // `data-empty`). An active pill always stays, whatever its count: it is the control
  // that turns the filter off. Other buckets already need a match to be ranked at all.
  const active = new Set(activeFilters.map((filter) => (filter.kind === "builtin" ? `b:${filter.id}` : `s:${filter.sender}`)));
  const keep = (pill: PillItem) =>
    pill.count > 0 ||
    active.has(pill.id.kind === "builtin" ? `b:${pill.id.id}` : `s:${pill.id.sender}`) ||
    (pill.id.kind === "builtin" && (PERMANENT_FILTERS as readonly string[]).includes(pill.id.id));
  return [...buckets, ...senders].filter(keep).map(display);
}

/**
 * The digit for a rail position, or `null` past the ninth pill.
 *
 * Shared so the printed shortcut and the rendered one cannot disagree: only nine
 * pills can have a digit, and a pill showing "10" as its key would be a lie.
 */
export function digitFor(index: number): string | null {
  return index < 9 ? String(index + 1) : null;
}
/**
 * The rail's scroll geometry, as plain numbers.
 *
 * Every tab's `[left, right]` in the scroller's content coordinates (`offsetLeft` and
 * `offsetLeft + offsetWidth`), the scroller's `scrollLeft`, `clientWidth` and
 * `scrollWidth`, and the two insets: how much of each end is *not* clear viewing space.
 * At the start that is the pinned mark and its veil; at the end it is the fade and the
 * step button over it. A tab is only properly on screen between the two.
 */
export type RailGeometry = {
  tabs: readonly (readonly [number, number])[];
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
  startInset: number;
  endInset: number;
};

function clampScroll(value: number, { clientWidth, scrollWidth }: RailGeometry): number {
  return Math.max(0, Math.min(Math.round(value), Math.max(0, scrollWidth - clientWidth)));
}

/**
 * Where to scroll so one tab sits fully in the clear part of the rail, or `null` when
 * it already does.
 *
 * Used when a tab takes keyboard focus. The browser's own scroll-into-view only makes
 * the tab *visible*, which at the end of the rail means "under the fade and the step
 * button" — a focused control you can barely read. This keeps it clear of both insets.
 */
export function scrollToReveal(geometry: RailGeometry, [left, right]: readonly [number, number]): number | null {
  const { scrollLeft, clientWidth, startInset, endInset } = geometry;
  const clearStart = scrollLeft + startInset;
  const clearEnd = scrollLeft + clientWidth - endInset;
  if (left >= clearStart - 1 && right <= clearEnd + 1) return null;
  // A tab wider than the clear area (a long sender name in a narrow window) cannot fit
  // either way; its start is what says what it is, so that is what is kept in view.
  const tooWide = right - left > clientWidth - startInset - endInset;
  const target = left < clearStart || tooWide ? left - startInset : right - clientWidth + endInset;
  const next = clampScroll(target, geometry);
  return next === Math.round(scrollLeft) ? null : next;
}

/**
 * One step of the rail's arrow buttons.
 *
 * Forward: the first tab that is not wholly in the clear (the one the fade is cutting
 * off) becomes the first tab after the mark, so nothing is skipped and a step never
 * lands mid-word. Back: the mirror image — the tab cut off at the start becomes the
 * last one before the fade. Falls back to a page of the clear width when a single tab
 * is wider than the whole clear area.
 */
export function stepRail(geometry: RailGeometry, direction: 1 | -1): number {
  const { tabs, scrollLeft, clientWidth, startInset, endInset } = geometry;
  const clearStart = scrollLeft + startInset;
  const clearEnd = scrollLeft + clientWidth - endInset;
  const clearWidth = Math.max(1, clientWidth - startInset - endInset);

  if (direction === 1) {
    const cut = tabs.find(([, right]) => right > clearEnd + 1);
    const target = cut && cut[0] - startInset > scrollLeft + 1 ? cut[0] - startInset : scrollLeft + clearWidth;
    return clampScroll(target, geometry);
  }
  const cut = [...tabs].reverse().find(([left]) => left < clearStart - 1);
  const target =
    cut && cut[1] - clientWidth + endInset < scrollLeft - 1
      ? cut[1] - clientWidth + endInset
      : scrollLeft - clearWidth;
  return clampScroll(target, geometry);
}

/**
 * A wheel event's vertical delta in pixels, for scrolling the rail sideways.
 *
 * `deltaMode` is 0 for pixels (Chromium, Safari, trackpads), 1 for lines (Firefox with
 * a mouse wheel: a notch is about 3) and 2 for pages. Read as pixels, a Firefox notch
 * moved the rail three pixels. A line is taken as 16px and a page as the rail's width.
 */
export function wheelPixels(delta: number, deltaMode: number, pageWidth: number): number {
  if (!Number.isFinite(delta)) return 0;
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * Math.max(1, pageWidth);
  return delta;
}

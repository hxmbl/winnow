/**
 * The phone list's scroller, and taking it back to its top: the dock's Inbox tab, the
 * panel's Inbox row on the plain inbox, and the back-to-top pill. Instant under reduced
 * motion. Also the phone's smart-filter rail, which the Inbox tab takes back to its first
 * pill (STRM-452). Its own module so the components that call it keep exporting only components.
 */

/** The phone list's scroller. One on screen at a time below `sm`. */
export function listScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-row-count]");
}

/** Smooth-scroll the list to its top, or jump there with reduced motion. */
export function scrollListToTop(): void {
  const scroller = listScroller();
  if (!scroller) return;
  const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  scroller.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}

/** The phone dock's smart-filter rail scroller, the one the chips above the pill swipe in. */
export function phoneRailScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-phone-chips] [data-rail-scroller]");
}

/** What `scrollRailToStart` needs of a scroller: only `scrollTo`, so it is tested without a DOM. */
export type HorizontalScroller = Pick<HTMLElement, "scrollTo">;

/**
 * Take a smart-filter rail back to its first pill (`scrollLeft` 0): smoothly, or with a
 * jump under reduced motion (STRM-452). Does nothing without a rail on screen.
 */
export function scrollRailToStart(
  scroller: HorizontalScroller | null = phoneRailScroller(),
  reduce: boolean = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
): void {
  if (!scroller) return;
  scroller.scrollTo({ left: 0, behavior: reduce ? "auto" : "smooth" });
}

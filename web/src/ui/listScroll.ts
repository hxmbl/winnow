/**
 * The phone list's scroller, and taking it back to its top: the dock's Inbox tab, the
 * panel's Inbox row on the plain inbox, and the back-to-top pill. Instant under reduced
 * motion. Its own module so the components that call it keep exporting only components.
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

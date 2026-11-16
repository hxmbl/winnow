/**
 * The phone list's scroller and taking it to an edge: the dock's Inbox tab, the panel's
 * Inbox row, the list-edge pill and Home all go back to the list's starting edge, the top
 * or the bottom depending on the sort direction. Instant under reduced motion. Also the
 * phone's smart-filter rail, which the Inbox tab takes back to its first pill (STRM-452).
 * Its own module so the components that call it keep exporting only components.
 */

/** The phone list's scroller. One on screen at a time below `sm`. */
export function listScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-row-count]");
}

/** Smooth-scroll the list to its top, or jump there with reduced motion. */
export function scrollListToTop(): void {
  const scroller = listScroller();
  if (!scroller) return;
  stopSettle();
  const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  scroller.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}

/**
 * Arming input that means the reader has taken the scroll back: the settle must not
 * fight a wheel, a touch, a drag or a key.
 */
const TAKE_OVER = ["pointerdown", "wheel", "touchstart", "keydown"] as const;

let settleFrame: number | null = null;
let settleRelease: (() => void) | null = null;

/** Stop a scroll settle in flight. Harmless when none is running. */
function stopSettle(): void {
  if (settleFrame !== null) cancelAnimationFrame(settleFrame);
  settleFrame = null;
  settleRelease?.();
  settleRelease = null;
}

/**
 * Land on the true bottom once the row window has measured.
 *
 * Rows are estimated at a fixed height until they mount, and on a long list those
 * estimates add up: aiming at `scrollHeight` early leaves the list a row or two short
 * of its newest mail, and the height keeps growing as the window fills. So after the
 * scroll settles, keep the offset at the bottom for as long as the height is still
 * moving, then stop two steady frames later. A reader's own input ends it at once.
 */
function settleOnBottom(scroller: HTMLElement): void {
  stopSettle();
  const release = () => stopSettle();
  for (const name of TAKE_OVER) globalThis.addEventListener(name, release, { passive: true });
  settleRelease = () => {
    for (const name of TAKE_OVER) globalThis.removeEventListener(name, release);
  };

  let frames = 0;
  let lastTop = scroller.scrollTop;
  let idle = 0;
  let lastMax = -1;
  let steady = 0;

  const tick = () => {
    settleFrame = null;
    frames += 1;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const top = scroller.scrollTop;
    // The smooth scroll is over once the offset stops moving between frames.
    if (top === lastTop) idle += 1;
    else {
      idle = 0;
      lastTop = top;
    }
    if (idle >= 2) {
      if (Math.abs(top - max) >= 1) {
        // The height grew after the scroll aimed; correct the last pixels.
        scroller.scrollTop = max;
        lastTop = scroller.scrollTop;
        lastMax = max;
        idle = 0;
        steady = 0;
      } else {
        steady = max === lastMax ? steady + 1 : 0;
        lastMax = max;
        if (steady >= 2) {
          stopSettle();
          return;
        }
      }
    }
    // A guard, not the plan: a list that never settles should not hold a frame loop.
    if (frames > 120) {
      stopSettle();
      return;
    }
    settleFrame = requestAnimationFrame(tick);
  };
  settleFrame = requestAnimationFrame(tick);
}

/** Smooth-scroll the list to its bottom, or jump there with reduced motion. */
export function scrollListToBottom(): void {
  const scroller = listScroller();
  if (!scroller) return;
  stopSettle();
  const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  settleOnBottom(scroller);
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

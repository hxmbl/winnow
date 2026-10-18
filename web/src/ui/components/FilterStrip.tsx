/**
 * The filter rail.
 *
 * The component carrying the most product meaning: these controls *are* Winnow's
 * opinion about your mail, made visible and reorderable, sitting in the masthead
 * because they are the mailbox, narrowed rather than a separate concern.
 *
 * Pills are ordered by the store, not here — the rail is ranked by how much mail each
 * bucket holds, so a component that re-sorted its own children would fight the store
 * on every render.
 *
 * Each pill is a rounded capsule with its own colour (`filterColors.ts`), drawn as a
 * soft tint so a row of twenty reads as one quiet line rather than a shelf of sweets;
 * the one that is on gets a stronger tint, a ring in its hue and a heavier label.
 *
 * A pill only switches its filter on and off; there is no control to hide a bucket
 * from the rail. "All" clears the active filters.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { filterKey, type FilterId } from "../../core/model/signals";
import { digitFor, scrollToReveal, stepRail, wheelPixels, type PillItem, type RailGeometry } from "../rail";

export type { PillItem } from "../rail";

type Props = {
  pills: PillItem[];
  activeFilters: FilterId[];
  onToggle: (id: FilterId) => void;
  onClear: () => void;
  /**
   * Pinned to the left edge of the scroller, with the pills passing underneath it.
   *
   * A slot rather than a sibling because hard-coding how much room the mark takes
   * proved fragile; `position: sticky; left: 0` cannot be mis-sized.
   */
  leading?: React.ReactNode;
  /**
   * The phone's floating rail: 44px pills for a thumb, each one its own frosted glass
   * chip (`.wn-chip-glass`) with no band behind the rail, so the list scrolls visibly
   * underneath. Inset at the sides like the dock's pill, and swiped, never stepped.
   */
  touch?: boolean;
  /**
   * The desktop's floating rail, over the list like the phone's: every chip its own glass
   * pill (`.wn-chip-glass`, the phone's recipe) at desktop size, no band and no edge fades
   * (a fade to the surface colour would be a band over moving mail, and a mask would be a
   * backdrop root that leaves the chips' blur nothing to blur). A chip running off an end
   * says "more" as on the phone, and the step button there is a small round glass button
   * of its own. Stepped and wheeled as before.
   */
  floating?: boolean;
  /**
   * The colour the rail sits on, which its desktop edge fades dissolve into. The phone's
   * floating rail sits on nothing and has no fades.
   */
  tone?: "canvas" | "surface";
  className?: string;
};

/**
 * How much of the rail's end the fade and the step button take, on the desktop.
 *
 * The rail is far longer than any window (twenty-odd tabs, ~3,700px), so at every width
 * one tab meets the end of it. With a 24px fade that tab read as *cut off by the search
 * box* — a word sliced mid-letter beside an unrelated control. The wider fade dissolves
 * it instead, and the step button sitting on the solid part says "there is more" in the
 * one way a mouse can act on: a mouse wheel scrolls vertically, the rail does not.
 */
const EDGE = 56;
/** The step button's own width, which is the solid part of `EDGE`. */
const STEP = 28;

export const FilterStrip = memo(function FilterStrip({
  pills,
  activeFilters,
  onToggle,
  onClear,
  leading,
  touch = false,
  floating = false,
  tone = "canvas",
  className = "",
}: Props) {
  const fade = `var(--wn-${tone})`;
  // 44px on touch: the dock's tabs are thumb targets like everything else there.
  const tabHeight = touch ? "h-11" : floating ? "h-8" : "h-7";
  // Glass chips, on the phone and on the desktop's floating rail.
  const glass = touch || floating;
  const hasActive = activeFilters.length > 0;
  const activeKeys = new Set(activeFilters.map(filterKey));
  const scrollerRef = useRef<HTMLDivElement>(null);

  const leadingRef = useRef<HTMLDivElement>(null);
  /** What changes the rail's content width: which pills, their counts, and "All". */
  const contentSignature = `${hasActive ? "all|" : ""}${pills
    .map((pill) => `${filterKey(pill.id)}:${pill.count}`)
    .join("|")}`;

  // The edge fade is only drawn when there is actually more to scroll to, so a short
  // rail does not get a mysterious gradient over its last pill.
  const [overflow, setOverflow] = useState({ start: false, end: false });
  // Where the start control sits: just after the pinned mark, which it must not cover.
  const [leadingWidth, setLeadingWidth] = useState(0);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;

    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = element;
      setOverflow({
        start: scrollLeft > 1,
        // One-pixel tolerance: fractional layout widths make a fully-scrolled
        // scroller report `scrollWidth > clientWidth` forever.
        end: scrollLeft + clientWidth < scrollWidth - 1,
      });
      setLeadingWidth(leadingRef.current?.offsetWidth ?? 0);
    };

    update();
    element.addEventListener("scroll", update, { passive: true });
    // A ResizeObserver rather than a window resize listener: the rail also reflows
    // when the pane it lives in changes width, which is not a window event. Its
    // children are observed too: the scroller keeps its own size when its *content*
    // grows ("All" appearing, a count gaining a digit, a pill going bold), and that is
    // exactly when the end fade and its step button have to appear.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (observer) {
      observer.observe(element);
      for (const child of element.children) observer.observe(child);
    }
    return () => {
      element.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [contentSignature]);

  /** The rail as numbers, for the pure helpers in `rail.ts`. */
  const geometry = useCallback((): RailGeometry | null => {
    const element = scrollerRef.current;
    if (!element) return null;
    const tabs = [...element.querySelectorAll<HTMLElement>("[data-rail-item]")].map(
      (item) => [item.offsetLeft, item.offsetLeft + item.offsetWidth] as const,
    );
    const lead = leadingRef.current?.offsetWidth ?? 0;
    return {
      tabs,
      scrollLeft: element.scrollLeft,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      // On touch the fades are a hint over a swipe, not controls, so they are narrow and
      // nothing needs to be kept out from under them beyond the mark.
      startInset: lead + (touch ? 0 : STEP + 4),
      endInset: touch ? 24 : EDGE,
    };
  }, [touch]);

  /**
   * Keep a focused tab clear of the fades and the step buttons.
   *
   * The browser scrolls a focused element into view on its own, but only just: at the end
   * of the rail that leaves it under the fade, legible to nobody. This runs after that
   * and finishes the job.
   */
  const onFocus = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>("[data-rail-item]");
      const element = scrollerRef.current;
      const shape = geometry();
      if (!item || !element || !shape) return;
      const next = scrollToReveal(shape, [item.offsetLeft, item.offsetLeft + item.offsetWidth]);
      if (next !== null) element.scrollLeft = next;
    },
    [geometry],
  );

  /**
   * Bring a tab that has just been switched on into the clear.
   *
   * An active tab keeps its place in the rail (the store no longer hoists it to the
   * front, so the digit shortcuts never repoint), which means a digit can switch on a
   * tab that is past the fade. Only the newly active one is revealed, so turning a
   * second filter on does not yank the rail back to the first.
   */
  const activeSignature = activeFilters.map(filterKey).join("|");
  const previousActive = useRef<Set<string>>(new Set());
  useEffect(() => {
    const element = scrollerRef.current;
    const now = new Set(activeSignature ? activeSignature.split("|") : []);
    const added = [...now].filter((key) => !previousActive.current.has(key));
    previousActive.current = now;
    if (!element || added.length === 0) return;
    const wanted = added[added.length - 1];
    const item = [...element.querySelectorAll<HTMLElement>("[data-rail-key]")].find(
      (candidate) => candidate.dataset.railKey === wanted,
    );
    const shape = geometry();
    if (!item || !shape) return;
    const next = scrollToReveal(shape, [item.offsetLeft, item.offsetLeft + item.offsetWidth]);
    if (next !== null) element.scrollLeft = next;
  }, [activeSignature, geometry]);

  const step = useCallback(
    (direction: 1 | -1) => {
      const element = scrollerRef.current;
      const shape = geometry();
      if (!element || !shape) return;
      const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      element.scrollTo({ left: stepRail(shape, direction), behavior: reduce ? "auto" : "smooth" });
    },
    [geometry],
  );

  /**
   * A mouse wheel moves the rail sideways.
   *
   * Nothing else in the masthead scrolls, so a vertical wheel over the rail has no other
   * meaning — and without this a mouse with no tilt wheel could only reach the tabs past
   * the edge through the step buttons.
   */
  const onWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const element = scrollerRef.current;
    if (!element || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    element.scrollLeft += wheelPixels(event.deltaY, event.deltaMode, element.clientWidth);
  }, []);

  return (
    <div className={`relative min-w-0 ${className}`}>
      <div
        ref={scrollerRef}
        data-rail-scroller=""
        onFocus={onFocus}
        onWheel={touch ? undefined : onWheel}
        // Touch: the rail is transparent and lets taps between the chips through to the
        // list; the vertical padding keeps the chips' shadows from being clipped by the
        // scroller, and the side padding matches the dock's insets.
        className={`no-scrollbar flex items-center overflow-x-auto ${
          touch
            ? "pointer-events-none gap-2 py-2 pl-[var(--wn-dock-left)] pr-[var(--wn-dock-right)] scroll-px-[var(--wn-dock-inset)] [&>*]:pointer-events-auto"
            : floating
              ? "pointer-events-none gap-1.5 px-0.5 py-1.5 [&>*]:pointer-events-auto"
              : "gap-1"
        }`}

      >
        {/*
          The mark, pinned. `z-10` so it paints above the pills travelling behind it;
          the veil fades them out underneath. The veil is `pointer-events-none` and
          `-left-3` so it covers the page padding too, with no seam at the window edge.
        */}
        {leading !== undefined && (
          <div ref={leadingRef} className="sticky left-0 z-10 flex shrink-0 items-center pr-2">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 -left-3 right-0"
              style={{ background: `linear-gradient(to right, ${fade}, ${fade} 50%, transparent)` }}
            />
            <div className="relative">{leading}</div>
          </div>
        )}

        {hasActive && (
          <button
            type="button"
            data-rail-item=""
            onClick={onClear}
            className={`${touch ? "wn-glass h-11 px-4" : floating ? "wn-glass h-8 px-3" : "h-7 px-2.5 hover:bg-sheen"} shrink-0 rounded-full text-ui font-semibold text-ink-body transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring`}
          >
            All
          </button>
        )}

      {pills.map(({ id, label, hue, count }, index) => {
        const key = filterKey(id);
        const on = activeKeys.has(key);
        // No digit on the phone dock: there is no number row to press.
        const digit = touch ? null : digitFor(index);

        return (
          <div
            key={key}
            data-rail-item=""
            data-rail-key={key}
            data-on={on ? "" : undefined}
            // The pill's identity only; the mode's recipe turns it into a fill.
            style={{ "--pill-h": hue.h, "--pill-s": hue.s } as React.CSSProperties}
            className={`wn-pill relative flex shrink-0 items-center rounded-full transition-colors duration-150 ${glass ? "wn-chip-glass" : ""}`}
          >
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(id)}
              // The count is in the accessible name, not just the visible number.
              aria-label={`${label}, ${count} ${count === 1 ? "message" : "messages"}`}
              // The digit shortcut, where it can be found without a keycap crowding the
              // tab: the tooltip, the shortcut sheet, and `aria-keyshortcuts`.
              // Always set: a long label is truncated, and this is where it is whole.
              title={digit ? `${label} (${digit})` : label}
              aria-keyshortcuts={digit ?? undefined}
              className={`relative flex ${tabHeight} items-center rounded-full text-ui whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                touch ? "gap-2 px-4" : floating ? "gap-1.5 px-3.5" : "gap-1.5 px-2.5"
              }`}
            >
              {/*
                The label at both weights in one grid cell, the semibold copy invisible:
                the cell is always as wide as the bolder one, so switching a pill on
                thickens its text without nudging every pill after it along the rail.
              */}
              {/*
                Capped, with an ellipsis: a sender pill is "From " plus whatever the
                address is, and an unbroken 60-character one was wider than a medium
                window's whole rail. The full label is in the title and the name.
              */}
              <span data-pill-label="" className="grid min-w-0 max-w-[14rem]">
                <span aria-hidden="true" className="invisible col-start-1 row-start-1 truncate font-semibold">
                  {label}
                </span>
                <span className={`col-start-1 row-start-1 truncate ${on ? "font-semibold" : "font-medium"}`}>{label}</span>
              </span>
              {/* `tabular-nums` so a count changing from 9 to 10 does not shift the label. */}
              <span className="wn-pill-count text-meta tabular-nums">{count}</span>
            </button>

          </div>
        );
      })}
      </div>

      {/* The phone's rail has no fades: it sits on nothing, and a chip running off the
          screen's edge says "swipe for more" by itself. */}

      {/*
        On the desktop each end that has more past it gets a wide fade and, on its solid
        part, a step button. The fade is still `pointer-events-none`; only the button
        takes clicks, and what it covers is by definition not legible enough to click.

        The buttons are out of the tab order (`tabIndex={-1}`): a keyboard reaches every
        tab directly, and `onFocus` above scrolls each one clear as it arrives, so a stop
        on "scroll right" between the last visible tab and the search field would be a
        detour. They keep a label for anyone who meets them with a pointer and a reader.
      */}
      {!touch && overflow.start && (
        <div
          data-rail-edge="start"
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center"
          // From the very left, under the mark: the mark's own veil fades to clear at its
          // right edge, and a tab passing beneath showed through that tail. This is solid
          // until the button's far side and only then fades, so between the mark and the
          // button there is nothing. The mark itself paints above it (`z-10`).
          style={{
            width: leadingWidth + EDGE,
            paddingLeft: leadingWidth,
            // Floating, there is no band to fade into: the chips fade out themselves.
            background: floating ? undefined : `linear-gradient(to right, ${fade} ${leadingWidth + STEP}px, transparent)`,
          }}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label="Scroll filters left"
            title="More filters"
            onClick={() => step(-1)}
            className={`pointer-events-auto relative flex h-7 items-center justify-center text-ink-icon transition-colors hover:text-ink ${
              floating ? "wn-glass rounded-full" : "rounded-ctl hover:bg-surface-hover"
            }`}
            style={{ width: STEP }}
          >
            <ChevronLeft size={16} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>
      )}
      {!touch && overflow.end && (
        <div
          data-rail-edge="end"
          className="pointer-events-none absolute inset-y-0 right-0 flex items-center justify-end"
          style={{ width: EDGE }}
        >
          {!floating && (
            <div
              aria-hidden="true"
              className="absolute inset-0"
              style={{ background: `linear-gradient(to left, ${fade} 50%, transparent)` }}
            />
          )}
          <button
            type="button"
            tabIndex={-1}
            aria-label="Scroll filters right"
            title="More filters"
            onClick={() => step(1)}
            className={`pointer-events-auto relative flex h-7 items-center justify-center text-ink-icon transition-colors hover:text-ink ${
              floating ? "wn-glass rounded-full" : "rounded-ctl hover:bg-surface-hover"
            }`}
            style={{ width: STEP }}
          >
            <ChevronRight size={16} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
});

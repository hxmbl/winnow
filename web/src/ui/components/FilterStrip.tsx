/**
 * The filter rail.
 *
 * The one colourful thing in the app, and the component that carries the most
 * product meaning: these pills *are* Winnow's opinion about your mail, made
 * visible and reorderable.
 *
 * Three things about the design are load-bearing:
 *
 *   - **Pills are ordered by the store, not here.** The rail is ranked by how
 *     much mail each bucket currently holds, with the two always-watch buckets
 *     pinned first. This component renders what it is given; it has no opinion
 *     about order, because a component that re-sorted its own children would
 *     fight the store's ranking on every render.
 *   - **Selected state is a ring, not a fill.** The wash is already the loudest
 *     thing in the strip; a second opaque fill would drown it, and the ring
 *     reads as a toggle at a glance.
 *   - **Each pill shows its count and its digit.** The digit is because the
 *     keyboard shortcut has to be discoverable *somewhere*, and a row of pills
 *     with an unexplained number under each one is the only honest place for it.
 */

import { memo, useEffect, useRef, useState } from "react";
import { filterKey, type BuiltinSmartFilter, type FilterId } from "../../core/model/signals";
import { pillBackground } from "../filterColors";
import { digitFor, type PillItem } from "../rail";

export type { PillItem } from "../rail";

type Props = {
  pills: PillItem[];
  activeFilters: FilterId[];
  onToggle: (id: FilterId) => void;
  onMute: (id: BuiltinSmartFilter) => void;
  onClear: () => void;
  className?: string;
};



export const FilterStrip = memo(function FilterStrip({
  pills,
  activeFilters,
  onToggle,
  onMute,
  onClear,
  className = "",
}: Props) {
  const hasActive = activeFilters.length > 0;
  const activeKeys = new Set(activeFilters.map(filterKey));
  const scrollerRef = useRef<HTMLDivElement>(null);

  // The strip scrolls, and a scroll container with a hard right edge reads as a
  // broken carousel rather than as "there is more here". The fade is only drawn
  // when there is actually more to scroll to, so a short rail does not get a
  // mysterious gradient over its last pill.
  const [overflow, setOverflow] = useState({ start: false, end: false });

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;

    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = element;
      setOverflow({
        start: scrollLeft > 1,
        // A one-pixel tolerance: fractional layout widths make a scroller that is
        // *just* fully scrolled report `scrollWidth > clientWidth` forever.
        end: scrollLeft + clientWidth < scrollWidth - 1,
      });
    };

    update();
    element.addEventListener("scroll", update, { passive: true });
    // A ResizeObserver rather than a window resize listener: the rail also
    // reflows when the pane it lives in changes width, which is not a window
    // event.
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [pills.length]);

  return (
    <div className={`relative min-w-0 ${className}`}>
      <div
        ref={scrollerRef}
        className="no-scrollbar flex items-center gap-1.5 overflow-x-auto"
      >
        {hasActive && (
          <button
            type="button"
            onClick={onClear}
            className="h-7 shrink-0 rounded-full border border-control-border px-3 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            All
          </button>
        )}

      {pills.map(({ id, label, colors, count, muted }, index) => {
        const key = filterKey(id);
        const on = activeKeys.has(key);
        const digit = digitFor(index);

        return (
          <div key={key} className="group/pill relative shrink-0">
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(id)}
              // The count is in the accessible name, not just the visible badge,
              // so a screen reader user gets the same information a sighted one
              // reads off the pill.
              aria-label={`${label}, ${count} ${count === 1 ? "message" : "messages"}`}
              className={`flex h-7 items-center gap-1.5 rounded-full pl-3 pr-2.5 text-ui font-semibold whitespace-nowrap text-ink-body transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                muted ? "opacity-45 line-through" : ""
              }`}
              style={{
                background: pillBackground(colors, on),
                boxShadow: on ? `inset 0 0 0 1px ${colors.solid}` : "none",
              }}
            >
              {label}
              {/* The count is deliberately not a badge: a second shape inside the
                  pill competes with the pill's own edge at this size. */}
              <span className="text-[11.5px] font-semibold tabular-nums text-ink-muted">
                {count}
              </span>
              {digit && (
                <span
                  aria-hidden="true"
                  className="hidden text-[11.5px] font-semibold tabular-nums text-ink-subtle group-hover/pill:inline lg:inline"
                >
                  {digit}
                </span>
              )}
            </button>

            {/* Mute, on hover or focus. Hidden for sender pills: there is no
                learning to do from muting one person, and the store has no model
                for it. */}
            {id.kind === "builtin" && id.id !== "unsafe" && !muted && (
              <button
                type="button"
                onClick={() => onMute(id.id)}
                title={`Hide ${label} from the inbox`}
                aria-label={`Hide ${label} from the inbox and tell Winnow it is over-firing`}
                className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-hairline bg-surface text-[10px] leading-none text-ink-muted shadow-pane transition-colors hover:text-danger focus-visible:inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring group-hover/pill:inline-flex"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      </div>

      {/* Fades, drawn over the scroll container. `pointer-events-none` because a
          gradient that eats clicks at the edge would make the last pill
          unclickable, which is the single worst possible bug in a filter rail. */}
      {overflow.start && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-chrome to-transparent"
        />
      )}
      {overflow.end && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-chrome to-transparent"
        />
      )}
    </div>
  );
});

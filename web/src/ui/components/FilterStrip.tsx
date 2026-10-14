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
 * They are text tabs now, not filled pills. A row of twenty tinted capsules was the
 * loudest thing in a window that is mostly for reading; a tab is a word and a count,
 * and the one that is on gets ink, weight and a short accent rule under it. The hide
 * control sits *inside* the tab, after the count, instead of as a badge perched on the
 * corner where it covered the neighbouring pill.
 */

import { memo, useEffect, useRef, useState } from "react";
import { filterKey, type BuiltinSmartFilter, type FilterId } from "../../core/model/signals";
import { digitFor, type PillItem } from "../rail";

export type { PillItem } from "../rail";

type Props = {
  pills: PillItem[];
  activeFilters: FilterId[];
  onToggle: (id: FilterId) => void;
  onMute: (id: BuiltinSmartFilter) => void;
  /** Undo a mute. Present because a mute has to be reversible from the rail. */
  onRestore: (id: BuiltinSmartFilter) => void;
  onClear: () => void;
  /**
   * Pinned to the left edge of the scroller, with the pills passing underneath it.
   *
   * A slot rather than a sibling because hard-coding how much room the mark takes
   * proved fragile; `position: sticky; left: 0` cannot be mis-sized.
   */
  leading?: React.ReactNode;
  /**
   * Touch sizing, for the phone dock: 40px pills and a larger hide control, so the rail
   * that carries the product can be worked with a thumb.
   */
  touch?: boolean;
  className?: string;
};

export const FilterStrip = memo(function FilterStrip({
  pills,
  activeFilters,
  onToggle,
  onMute,
  onRestore,
  onClear,
  leading,
  touch = false,
  className = "",
}: Props) {
  // 44px on touch: the dock's tabs are thumb targets like everything else there.
  const tabHeight = touch ? "h-11" : "h-7";
  const hasActive = activeFilters.length > 0;
  const activeKeys = new Set(activeFilters.map(filterKey));
  const scrollerRef = useRef<HTMLDivElement>(null);

  // The edge fade is only drawn when there is actually more to scroll to, so a short
  // rail does not get a mysterious gradient over its last pill.
  const [overflow, setOverflow] = useState({ start: false, end: false });

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
    };

    update();
    element.addEventListener("scroll", update, { passive: true });
    // A ResizeObserver rather than a window resize listener: the rail also reflows
    // when the pane it lives in changes width, which is not a window event.
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
        className={`no-scrollbar flex items-center overflow-x-auto ${touch ? "gap-1 pr-1.5" : "gap-0.5"}`}
      >
        {/*
          The mark, pinned. `z-10` so it paints above the pills travelling behind it;
          the veil fades them out underneath. The veil is `pointer-events-none` and
          `-left-3` so it covers the page padding too, with no seam at the window edge.
        */}
        {leading !== undefined && (
          <div className="sticky left-0 z-10 flex shrink-0 items-center pr-2">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 -left-3 right-0 bg-gradient-to-r from-canvas via-canvas to-transparent"
            />
            <div className="relative">{leading}</div>
          </div>
        )}

        {hasActive && (
          <button
            type="button"
            onClick={onClear}
            className={`${touch ? "h-11 px-3.5" : "h-7 px-2.5"} shrink-0 rounded-ctl text-ui font-semibold text-ink-body transition-colors duration-150 hover:bg-sheen hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring`}
          >
            All
          </button>
        )}

      {pills.map(({ id, label, count, muted }, index) => {
        const key = filterKey(id);
        const on = activeKeys.has(key);
        // No digit for a muted pill: a shortcut to a bucket that is not filterable
        // would do nothing. Nor on the phone dock: there is no number row to press.
        const digit = muted || touch ? null : digitFor(index);
        const isMuted = muted === true;
        const hideable = id.kind === "builtin" && id.id !== "unsafe";

        return (
          <div
            key={key}
            className={`group/pill relative flex shrink-0 items-center rounded-ctl transition-colors duration-150 ${
              isMuted ? "" : "hover:bg-sheen"
            }`}
          >
            <button
              type="button"
              aria-pressed={on}
              // A muted pill is not a toggle, so it is not pressed — saying otherwise
              // describes a state the app will not enter.
              disabled={isMuted}
              onClick={() => onToggle(id)}
              // The count is in the accessible name, not just the visible number.
              aria-label={
                isMuted
                  ? `${label}, hidden — ${count} ${count === 1 ? "message" : "messages"}`
                  : `${label}, ${count} ${count === 1 ? "message" : "messages"}`
              }
              // The digit shortcut, where it can be found without a keycap crowding the
              // tab: the tooltip, the shortcut sheet, and `aria-keyshortcuts`.
              title={digit ? `${label} (${digit})` : undefined}
              aria-keyshortcuts={digit ?? undefined}
              className={`relative flex ${tabHeight} items-center gap-1.5 rounded-ctl text-ui whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-default ${
                hideable ? (touch ? "pl-3.5 pr-1" : "pl-2 pr-0.5") : touch ? "px-3.5" : "px-2"
              } ${
                isMuted
                  ? "text-ink-subtle line-through opacity-60"
                  : on
                    ? "font-semibold text-ink"
                    : "font-medium text-ink-muted group-hover/pill:text-ink-body"
              }`}
            >
              {label}
              {/* `tabular-nums` so a count changing from 9 to 10 does not shift the label. */}
              <span className={`text-meta tabular-nums ${on ? "text-ink-muted" : "text-ink-subtle"}`}>
                {count}
              </span>
              {/*
                On: a short rule in the accent under the label and count. Drawn rather
                than an `underline` so it sits at the foot of the tab instead of hugging
                the baseline, and is the same 2px on every tab.
              */}
              {on && (
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute bottom-0 h-0.5 rounded-full bg-accent ${
                    touch ? `left-3.5 ${hideable ? "right-1" : "right-3.5"}` : `left-2 ${hideable ? "right-0.5" : "right-2"}`
                  }`}
                />
              )}
            </button>

            {/*
              One control per builtin pill, in whichever direction it points: hide the
              bucket on a live pill, bring it back on a muted one — so a mute is not a
              one-way door. `unsafe` has neither, as it is not hidden by default.

              Inside the tab, after the count. `opacity-0` rather than `hidden`:
              `display: none` takes the control out of the tab order, where
              `focus-visible` cannot rescue it — and the space stays reserved, so hovering
              never shifts the rail. `[@media(hover:none)]` shows it outright on touch.
            */}
            {hideable && (
              <button
                type="button"
                onClick={() => (isMuted ? onRestore(id.id) : onMute(id.id))}
                title={
                  isMuted
                    ? `Show ${label} in the inbox again`
                    : `Hide ${label} from the inbox`
                }
                aria-label={
                  isMuted
                    ? `Show ${label} in the inbox again`
                    : `Hide ${label} from the inbox and tell Winnow it is over-firing`
                }
                className={`inline-flex shrink-0 items-center justify-center rounded-ctl leading-none text-ink-subtle opacity-0 transition-opacity duration-150 hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring group-hover/pill:opacity-100 [@media(hover:none)]:opacity-100 ${
                  touch ? "mr-1 h-11 w-8 text-read" : "mr-0.5 h-6 w-4 text-ui"
                }`}
              >
                {isMuted ? "↺" : "×"}
              </button>
            )}
          </div>
        );
      })}
      </div>

      {/* Fades, drawn over the scroll container. `pointer-events-none` because a
          gradient that eats clicks at the edge would make the last pill unclickable,
          which is the single worst possible bug in a filter rail. */}
      {overflow.start && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-canvas to-transparent"
        />
      )}
      {overflow.end && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-canvas to-transparent"
        />
      )}
    </div>
  );
});

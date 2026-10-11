/**
 * The filter rail.
 *
 * The component carrying the most product meaning: these controls *are* Winnow's
 * opinion about your mail, made visible and reorderable, sitting in the masthead
 * because they are the mailbox, narrowed rather than a separate concern.
 *
 * Pills are ordered by the store, not here — the rail is ranked by how much mail each
 * bucket holds, so a component that re-sorted its own children would fight the store
 * on every render. Selected state is illumination, not a second fill: each pill already
 * carries a wash of its own accent, and what is left on "on" is a `sheen` — a
 * low-alpha wash of the palette's own ink — so it reads as the row lifting toward the
 * light rather than as a different object being placed on top of it. Each pill shows
 * its count and its keyboard digit, because the shortcut has to be discoverable
 * somewhere.
 *
 * The accent colours survive as a tint; the label says which bucket this is, so the
 * rail reads as one quiet row rather than as a row of sweets.
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
  className = "",
}: Props) {
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
        className="no-scrollbar flex items-center gap-1.5 overflow-x-auto"
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
            className="h-7 shrink-0 rounded-full bg-sheen px-3 text-ui font-semibold text-ink-body transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            All
          </button>
        )}

      {pills.map(({ id, label, colors, count, muted }, index) => {
        const key = filterKey(id);
        const on = activeKeys.has(key);
        // No digit for a muted pill: a shortcut to a bucket that is not filterable
        // would do nothing.
        const digit = muted ? null : digitFor(index);
        const isMuted = muted === true;

        return (
          <div key={key} className="group/pill relative shrink-0">
            <button
              type="button"
              aria-pressed={on}
              // A muted pill is not a toggle, so it is not pressed — saying otherwise
              // describes a state the app will not enter.
              disabled={isMuted}
              onClick={() => onToggle(id)}
              // The count is in the accessible name, not just the visible badge.
              aria-label={
                isMuted
                  ? `${label}, hidden — ${count} ${count === 1 ? "message" : "messages"}`
                  : `${label}, ${count} ${count === 1 ? "message" : "messages"}`
              }
              className={`flex h-7 items-center gap-1.5 rounded-full pl-3 pr-2.5 text-ui font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-default ${
                isMuted
                  ? "text-ink-subtle line-through opacity-60"
                  : on
                    ? "font-semibold text-ink"
                    : "text-ink-muted hover:text-ink-body"
              }`}
              style={{
                // A muted pill gets no fill rather than a dimmed one: a tinted empty
                // pill still reads as an enabled control that is merely quiet.
                background: isMuted ? "transparent" : pillBackground(colors, on),
              }}
            >
              {label}
              {/* Not a badge: a second shape inside the pill competes with the pill's
                  own edge at this size. `tabular-nums` so a count changing from 9 to
                  10 does not shift the label, and it sits right after the label so the
                  pair reads as one unit — "Important 26". */}
              <span className="text-[11.5px] font-semibold tabular-nums text-ink-muted">
                {count}
              </span>
              {/*
                The shortcut, drawn as a key rather than as plain adjacent text: a
                number next to a count made every pill read as one number ("Important
                26 1"), where the second digit is a keyboard shortcut. The keycap
                separates the two roles and ties the pill to the shortcut sheet's chip.

                `bg-surface` solid, and *not* `bg-surface/60`. Tailwind's `/opacity`
                on a custom-property colour produces `rgb(var(--wn-surface) / 0.6)`,
                which is not a colour, so the fill silently disappears.

                `font-mono` because a digit that is a *key* should look like a key.
              */}
              {digit && (
                <kbd
                  aria-hidden="true"
                  className="ml-0.5 hidden min-w-[1.05rem] rounded bg-sheen px-1 py-px text-center font-mono text-[10.5px] font-semibold leading-[1.35] text-ink-muted group-hover/pill:inline lg:inline"
                >
                  {digit}
                </kbd>
              )}
            </button>

            {/*
              One control per builtin pill, in whichever direction it points: hide the
              bucket on a live pill, bring it back on a muted one — so a mute is not a
              one-way door. `unsafe` has neither, as it is not hidden by default.

              `opacity-0` rather than `hidden`: `display: none` takes the control out
              of the tab order, where `focus-visible` cannot rescue it.
              `[@media(hover:none)]` still shows it outright on touch, so no device is
              left with a transparent tappable target.
            */}
            {id.kind === "builtin" && id.id !== "unsafe" && (
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
                className="absolute -right-1 -top-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-veil text-[10px] leading-none text-ink-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring group-hover/pill:opacity-100 [@media(hover:none)]:opacity-100"
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

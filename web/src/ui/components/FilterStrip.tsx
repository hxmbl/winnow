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
  /** Undo a mute. Present because a mute has to be reversible from the rail. */
  onRestore: (id: BuiltinSmartFilter) => void;
  onClear: () => void;
  className?: string;
};

export const FilterStrip = memo(function FilterStrip({
  pills,
  activeFilters,
  onToggle,
  onMute,
  onRestore,
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
        // No digit for a muted pill. The rail's digits are what `1`–`9` address, and a
        // muted bucket is not filterable — printing a shortcut on it would be a
        // shortcut that does nothing.
        const digit = muted ? null : digitFor(index);
        const isMuted = muted === true;

        return (
          <div key={key} className="group/pill relative shrink-0">
            <button
              type="button"
              aria-pressed={on}
              // A muted pill is not a toggle. It is not pressed, it cannot be pressed,
              // and saying otherwise to a screen reader describes a state the app
              // will not enter.
              disabled={isMuted}
              onClick={() => onToggle(id)}
              // The count is in the accessible name, not just the visible badge, so a
              // screen reader user gets the same information a sighted one reads off
              // the pill.
              aria-label={
                isMuted
                  ? `${label}, hidden — ${count} ${count === 1 ? "message" : "messages"}`
                  : `${label}, ${count} ${count === 1 ? "message" : "messages"}`
              }
              className={`flex h-7 items-center gap-1.5 rounded-full pl-3 pr-2.5 text-ui font-semibold whitespace-nowrap text-ink-body transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-default ${
                isMuted ? "opacity-45 line-through" : ""
              }`}
              style={{
                background: pillBackground(colors, on && !isMuted),
                boxShadow: on && !isMuted ? `inset 0 0 0 1px ${colors.solid}` : "none",
              }}
            >
              {label}
              {/* The count is deliberately not a badge: a second shape inside the
                  pill competes with the pill's own edge at this size. It carries a
                  `tabular-nums` so a count changing from 9 to 10 does not shift the
                  label, and it sits immediately after the label so the pair reads as
                  one unit — "Important 26" — with the keycap clearly separate. */}
              <span className="text-[11.5px] font-semibold tabular-nums text-ink-muted">
                {count}
              </span>
              {/*
                The shortcut, drawn as a key rather than as a number.

                It was plain adjacent text at `text-ink-subtle`, which made every pill
                read as one number — "Important 26 1", "Deliveries 2 2" — where the
                second digit is a keyboard shortcut and the first is a count. On a
                two-digit count ("26 1") the ambiguity is not stylistic: it is a
                number that could be misread as twenty-six-one. The keycap separates
                the two roles at a glance and ties the pill to the same chip the
                shortcut sheet draws.

                `bg-surface` solid, and *not* `bg-surface/60`. The token colours are CSS
                custom properties, so Tailwind's `/opacity` modifier produces
                `rgb(var(--wn-surface) / 0.6)` — which is not a colour — and the fill
                silently disappears, leaving the key glyph on the pill's wash. That is
                exactly what `theme.ts` warns about at the top of the file, and the
                keycap is where it bit.

                `font-mono` because a digit that is a *key* should look like a key, and
                `ink-muted` rather than `ink-subtle` so it is legible on white in both
                schemes.
              */}
              {digit && (
                <kbd
                  aria-hidden="true"
                  className="ml-0.5 hidden min-w-[1.05rem] rounded border border-hairline bg-surface px-1 py-px text-center font-mono text-[10.5px] font-semibold leading-[1.35] text-ink-muted group-hover/pill:inline lg:inline"
                >
                  {digit}
                </kbd>
              )}
            </button>

            {/*
              One control per builtin pill, in whichever direction it points.

              On a live pill it hides the bucket; on a muted one it brings the bucket
              back. That is the reason a mute is not a one-way door: the pill that hid
              the mail is the pill that un-hides it, so undoing it is where the user
              already is rather than a hunt through Settings.

              `unsafe` has neither — it is not hidden by default, so there is nothing to
              unhide, and muting it is meaningless (it is the one bucket the user goes to
              on purpose).

              The last clause is the touch device, and it is not decoration. The control
              was `hidden` and revealed on `group-hover`, which on a phone means never:
              there is no mute control at all, so a bucket Winnow keeps mis-filing cannot
              be silenced from the rail. Settings can list what has already been hidden
              but cannot start it, and the palette is a list of places to go, not a list
              of things to change. `@media (hover: hover)` scopes the hiding to the
              devices that actually have a pointer to hover with, exactly as it does for
              the row star.
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
                className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-hairline bg-surface text-[10px] leading-none text-ink-muted shadow-pane transition-colors hover:text-ink focus-visible:inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring group-hover/pill:inline-flex [@media(hover:none)]:inline-flex"
              >
                {isMuted ? "↺" : "×"}
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

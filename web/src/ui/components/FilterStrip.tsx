/**
 * The filter rail.
 *
 * The component that carries the most product meaning: these controls *are*
 * Winnow's opinion about your mail, made visible and reorderable. They sit in the
 * masthead rather than in a bar of their own, because they are not a separate
 * concern from the mailbox — they are the mailbox, narrowed.
 *
 * Three things about the design are load-bearing:
 *
 *   - **Pills are ordered by the store, not here.** The rail is ranked by how
 *     much mail each bucket currently holds, with the two always-watch buckets
 *     pinned first. This component renders what it is given; it has no opinion
 *     about order, because a component that re-sorted its own children would
 *     fight the store's ranking on every render.
 *   - **Selected state is illumination, not a second fill.** Each pill already
 *     carries a wash of its own accent; an opaque fill on top of that drowned it,
 *     and an inset ring around it drew a hard edge on a surface that is meant to
 *     have none. What is left is a `sheen` — a low-alpha wash of the palette's own
 *     ink — so "on" reads as the row lifting toward the light rather than as a
 *     different object being placed on top of it.
 *   - **Each pill shows its count and its digit.** The digit is because the
 *     keyboard shortcut has to be discoverable *somewhere*, and a row of pills
 *     with an unexplained number under each one is the only honest place for it.
 *
 * The accent colours survive, but they are no longer what says *which bucket this
 * is* — the label does that. They are a tint, and the rail reads as one quiet row
 * rather than as a row of sweets.
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
   * A slot rather than a sibling because the alternative was hard-coding how much room
   * the mark takes: the rail was absolutely positioned across the whole row and inset
   * on the left by the logo's width and on the right by the search cluster's, which is
   * a magic number that has to be re-measured every time either of those changes. It
   * was wrong twice — once because `pr-24` is Tailwind's 6rem and not 24rem, and once
   * because adding a button to the cluster made the right inset 33px short, which put
   * the last pill's mute control underneath the search field where it could be seen and
   * not clicked.
   *
   * `position: sticky; left: 0` cannot be mis-sized. The mark stays where it is, the
   * pills travel leftward behind it, and the scroller's own clip does the rest.
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
        {/*
          The mark, pinned. `z-10` so it paints above the pills travelling behind it,
          and the veil so they fade out underneath rather than being chopped off by a
          hard edge. The veil is `pointer-events-none` and `-left-3` so it covers the
          page padding as well as the mark, with no seam at the window edge.
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
              className={`flex h-7 items-center gap-1.5 rounded-full pl-3 pr-2.5 text-ui font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-default ${
                isMuted
                  ? "text-ink-subtle line-through opacity-60"
                  : on
                    ? "font-semibold text-ink"
                    : "text-ink-muted hover:text-ink-body"
              }`}
              style={{
                // A muted pill has nothing to filter, so it gets no fill at all rather
                // than a dimmed one — a tinted empty pill still reads as an enabled
                // control that is merely quiet.
                background: isMuted ? "transparent" : pillBackground(colors, on),
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
                  className="ml-0.5 hidden min-w-[1.05rem] rounded bg-sheen px-1 py-px text-center font-mono text-[10.5px] font-semibold leading-[1.35] text-ink-muted group-hover/pill:inline lg:inline"
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

              `opacity-0` rather than `hidden`, and that is the fix rather than a
              restatement of the rule above. `display: none` takes a control out of the
              tab order, so a desktop keyboard user could never reach the one button
              that silences a bucket Winnow keeps mis-filing — and the
              `focus-visible:opacity-100` in this class list could not rescue them,
              because an element that cannot be focused cannot match a focus rule.
              `visibility: hidden` is the same trap. Transparency is the only hiding
              that leaves a control focusable, and `[@media(hover: none)]` still shows
              it outright on touch, so no device is left with a transparent tappable
              target where there used to be none.
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
          gradient that eats clicks at the edge would make the last pill
          unclickable, which is the single worst possible bug in a filter rail. */}
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

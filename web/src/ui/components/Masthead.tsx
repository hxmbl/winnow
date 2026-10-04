/**
 * The masthead.
 *
 * Identity and actions, the filter rail and a status line used to be three stacked
 * strips — about 127px of chrome above a reading surface, with a `border-b` under
 * each. That was the clearest statement in the app that the chrome and the mail
 * were two different things sitting next to each other.
 *
 * This is **one row**, and nothing in it is a separate object:
 *
 *   - **The logo, the rail, and the position cluster share a single surface.**
 *     There is no rule under any of them. The hierarchy between "what am I looking
 *     at" and "what am I looking at *filtered by*" is spacing and weight, which is
 *     the whole argument this design is making.
 *   - **The rail runs the full width and the filters pass underneath the logo.**
 *     The rail is absolutely positioned across the whole row and its content is
 *     inset by the logo's width, so at rest the first pill clears the mark and
 *     scrolling moves the pills leftward *under* it. The mark carries a soft veil
 *     that fades to the right, so they emerge from behind it rather than being cut
 *     off by it. The logo does not move, and no second navigation structure appears
 *     above or below to hold it still — the strip simply continues underneath.
 *   - **The mailbox menu is not here.** It is what the logo opens.
 *   - **Neither are the email actions.** Those belong to the message, so they are in
 *     the reader, where the message is.
 *
 * Search and the position cluster stay: both are about the *list*, they were never
 * part of the navigation, and removing them would remove working functionality
 * rather than change a visual language. They sit at the right, over the rail, with
 * the same veil the logo uses — so nothing occludes anything without looking like
 * it is occluding something.
 */

import { Check, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { shortcutFor } from "../../core/mail/keybinds";
import { AppMark } from "../AppMark";
import { FilterStrip, type PillItem } from "./FilterStrip";
import type { BuiltinSmartFilter, FilterId } from "../../core/model/signals";

export type MastheadProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  /**
   * The search input's element.
   *
   * A ref, and it has to be the same ref the keybind handler in `App.tsx` holds:
   * `/` has to focus this exact element. If the two diverge, `/` silently does
   * nothing and every later keystroke is swallowed by the keyboard layer.
   */
  searchRef: React.RefObject<HTMLInputElement | null>;
  pills: PillItem[];
  activeFilters: readonly FilterId[];
  onToggleFilter: (id: FilterId) => void;
  onMute: (id: BuiltinSmartFilter) => void;
  onRestoreFilter: (id: BuiltinSmartFilter) => void;
  onClearFilters: () => void;
  /** Open the navigation drawer. This is what the logo is for. */
  onOpenNavigation: () => void;
  navigationOpen: boolean;
  position: number | null;
  total: number;
  /** "Inbox", "From ada@example.com", or "Filtered". Answerable: 40 of what? */
  listTitle: string;
  cursorIndex: number;
  onPrev: () => void;
  onNext: () => void;
  /**
   * Mark the whole mailbox read.
   *
   * It is not an email action — it is about every message on screen, which is what
   * the list is — so it belongs here, beside the readout that tells you how many
   * there are. It is the only button in this row that is not about navigation,
   * search or position.
   *
   * `⇧U` is the same verb and the button says so, which is the only place a user can
   * discover it: it is the most destructive keystroke in the product — there is no
   * inverse anywhere except the undo strip — and the strip only appears *after* it
   * has been pressed.
   */
  onMarkAllRead: () => void;
};

export function Masthead({
  searchQuery,
  onSearchChange,
  searchRef,
  pills,
  activeFilters,
  onToggleFilter,
  onMute,
  onRestoreFilter,
  onClearFilters,
  onOpenNavigation,
  navigationOpen,
  position,
  total,
  listTitle,
  cursorIndex,
  onPrev,
  onNext,
  onMarkAllRead,
}: MastheadProps) {
  return (
    // No `border-b`, no `bg-chrome`. The header is the same surface as the mailbox
    // below it, and it is separated from it by nothing but the change in what the two
    // contain.
    <header className="relative z-30 shrink-0">
      {/*
        Wraps below `sm`, and the rail keeps the first line when it does.

        A single row needs the rail, the search field and the position cluster to fit
        side by side, and the cluster alone measures 319px — against a 390px phone.
        The rail was getting *zero* width there, which is the quietest possible way to
        remove the product from the smallest screen: no error, no overflow, just an
        empty strip.

        So on a phone the rail takes the first line in full — mark and filters
        together, which is also the pair that belongs together — and the search and
        position go underneath it. The mark stays `sticky` inside the scroller either
        way, so the filters still travel underneath it on the one screen where there is
        room for that to mean anything.
      */}
      <div className="flex min-h-14 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 sm:h-14 sm:flex-nowrap sm:py-0">
        {/*
          The rail, with the mark pinned inside it.

          Three flex children and no absolute positioning anywhere: the rail takes what
          is left over, and the search cluster is `ml-auto`. The interaction that
          matters — the filters passing underneath the mark — belongs to the rail, and
          `FilterStrip` does it with `position: sticky` on the mark inside the scroller.

          This replaced a layout that positioned the rail absolutely across the whole
          row and inset it by hand at both ends. Both inset numbers were wrong in ways
          only a browser would show: `pr-24` is Tailwind's 6rem and not 24rem, and the
          right inset silently fell 33px behind the search cluster when a button was
          added to it — which left the last pill's mute control visible, underneath the
          search field, and unclickable.
        */}
        <FilterStrip
          pills={pills}
          activeFilters={activeFilters as FilterId[]}
          onToggle={onToggleFilter}
          onMute={onMute}
          onRestore={onRestoreFilter}
          onClear={onClearFilters}
          leading={
            <button
              type="button"
              onClick={onOpenNavigation}
              aria-expanded={navigationOpen}
              aria-haspopup="dialog"
              aria-label="Open navigation"
              title="Navigation"
              className="flex h-9 w-9 items-center justify-center rounded-full transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <AppMark />
            </button>
          }
          className="order-1 w-full min-w-0 sm:w-auto sm:flex-1"
        />
        <span className="sr-only">Winnow</span>

        {/*
          Search and where-you-are, `ml-auto` so the rail takes the remainder rather
          than a hand-measured share of it.
        */}
        <div className="order-2 ml-auto flex shrink-0 items-center gap-2">
          <label
            htmlFor="winnow-search"
            /*
              Focus is drawn on the *label*, not the input, via `focus-within`. Two
              reasons: the input is a bare text box inside a rounded field, so an
              outline on it would be a rectangle floating inside a pill; and the thing
              that changes on focus is the field, not the glyphs inside it.

              An audit of every tab stop found this was the only control in the app
              with no visible focus indication at all — it had a fill shift from white
              to `surfaceActive`, which is real but too slight to be an indicator. The
              ring utility the rest of the app uses is deliberately not applied here,
              because `ring-2` composes `box-shadow` out of custom properties and
              silently resolves to `none` on some elements; see the note in
              `index.css`.
            */
            className="flex h-8 w-[11rem] items-center gap-2 rounded-full bg-surface px-3 transition-colors focus-within:bg-surface-active focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--wn-focusRing)] xl:w-[13rem]"
          >
            <Search size={14} className="shrink-0 text-ink-placeholder" aria-hidden="true" />
            <input
              id="winnow-search"
              ref={searchRef}
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent text-ui font-medium text-ink outline-none placeholder:text-ink-placeholder"
            />
          </label>

          {/*
            The position cluster. Unboxed: it was a bordered pill around a number and
            two arrows, which is a control pretending to be a control — the number is
            a readout and the arrows are the only interactive part, and neither needs a
            container to be findable.

            The list's own name is dropped below `xl`. It is the longest string here and
            the least load-bearing: the active mailbox is in the drawer one tap away, and
            "3/38" says the same as "Inbox — 3/38".
          */}
          <div className="flex items-center gap-0.5">
            <span
              className="mr-1 hidden max-w-[9rem] truncate text-ui font-medium text-ink-muted xl:inline"
              title={listTitle}
            >
              {listTitle}
            </span>
            <span className="text-ui font-semibold tabular-nums text-ink">
              {position ?? "—"}
            </span>
            <span className="text-ui tabular-nums text-ink-subtle">/ {total}</span>
            <button
              type="button"
              onClick={onPrev}
              aria-label="Previous message"
              disabled={cursorIndex <= 0}
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <ChevronLeft size={17} />
            </button>
            <button
              type="button"
              onClick={onNext}
              aria-label="Next message"
              disabled={total === 0 || cursorIndex >= total - 1}
              className="flex h-7 w-7 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <ChevronRight size={17} />
            </button>
            {/*
              The rationale for this living in the masthead at all is on the
              `onMarkAllRead` prop, which is where the reasoning does not change
              depending on how the button happens to be rendered.
            */}
            <button
              type="button"
              onClick={onMarkAllRead}
              aria-label="Mark all read"
              title={
                shortcutFor("markAllRead")
                  ? `Mark all read — ${shortcutFor("markAllRead")}`
                  : "Mark all read"
              }
              disabled={total === 0}
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Check size={15} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

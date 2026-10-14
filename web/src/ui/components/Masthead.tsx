/**
 * The desktop list's header: search across the full width of the list column with
 * where you are in the list beside it, then the filter rail on its own row.
 *
 * The smart filters are the rail (`FilterStrip`), not sidebar rows: text tabs with
 * their counts, ranked by the store, fading into a step chevron at either edge. It has
 * the list column's full width to itself, so the search field can never sit over its
 * last tab. Folders and the account are the floating sidebar's (`MailNav.tsx`).
 */

import { Check, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { shortcutFor } from "../../core/mail/keybinds";
import { FilterStrip, type PillItem } from "./FilterStrip";
import type { BuiltinSmartFilter, FilterId } from "../../core/model/signals";

export type MastheadProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  /**
   * The search input's element.
   *
   * Must be the same ref the keybind handler in `App.tsx` holds: `/` has to focus this
   * exact element. If the two diverge, `/` silently does nothing.
   */
  searchRef: React.RefObject<HTMLInputElement | null>;
  pills: PillItem[];
  activeFilters: readonly FilterId[];
  onToggleFilter: (id: FilterId) => void;
  onMute: (id: BuiltinSmartFilter) => void;
  onRestoreFilter: (id: BuiltinSmartFilter) => void;
  onClearFilters: () => void;
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
   * Not an email action — it is about every message on screen — so it lives beside the
   * readout of how many there are.
   *
   * `⇧U` is the same verb and the button says so, which is the only place a user can
   * discover it: it is the most destructive keystroke in the product, whose only
   * inverse is the undo strip, and the strip only appears *after* it has been pressed.
   */
  onMarkAllRead: () => void;
};

/**
 * Where you are in the list: "12 of 39" once the cursor is on something, and just the
 * total before. It used to be "— / 39" — a dash standing in for a number, then a slash
 * that read like a fraction. `data-position` is for the smoke test, which asserts that
 * an untouched list does not claim a row.
 */
export function PositionReadout({
  position,
  total,
  className = "",
}: {
  position: number | null;
  total: number;
  className?: string;
}) {
  return (
    <span data-position="" className={`text-ui tabular-nums text-ink-muted ${className}`}>
      {position === null || total === 0 ? (
        <span className="font-medium text-ink">{total}</span>
      ) : (
        <>
          <span className="font-medium text-ink">{position}</span> of {total}
        </>
      )}
    </span>
  );
}

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
  position,
  total,
  listTitle,
  cursorIndex,
  onPrev,
  onNext,
  onMarkAllRead,
}: MastheadProps) {
  return (
    // No `border-b`, no `bg-chrome`: the header is the same surface as the list below
    // it, separated by nothing but the change in what the two contain.
    <header data-masthead="" className="relative z-20 shrink-0">
      <div className="flex h-14 min-w-0 items-center gap-3 px-4">
        {/* Search takes the width; where-you-are keeps its own. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <label
            htmlFor="winnow-search"
            /*
              Focus is drawn on the *label*, not the input, via `focus-within`: the
              input is a bare text box inside a rounded field, so an outline on it would
              be a rectangle floating inside a pill.

              The app's `ring` utility is deliberately not used here, because `ring-2`
              composes `box-shadow` out of custom properties and silently resolves to
              `none` on some elements; see the note in `index.css`.
            */
            className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-ctl border border-edge bg-canvas px-3 transition-colors focus-within:bg-surface-active focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--wn-focusRing)]"
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
            The position cluster. Unboxed: the number is a readout and the arrows are the
            only interactive part, so neither needs a container to be findable.

            The list's own name is dropped below `xl` — it is the longest and least
            load-bearing string here, and "3/38" says the same as "Inbox — 3/38".
          */}
          <div className="flex shrink-0 items-center gap-0.5">
            <span
              className="mr-2 hidden max-w-[9rem] truncate text-ui font-medium text-ink-muted xl:inline"
              title={listTitle}
            >
              {listTitle}
            </span>
            <PositionReadout position={position} total={total} />
            <button
              type="button"
              onClick={onPrev}
              aria-label="Previous message"
              disabled={cursorIndex <= 0}
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <ChevronLeft size={17} />
            </button>
            <button
              type="button"
              onClick={onNext}
              aria-label="Next message"
              disabled={total === 0 || cursorIndex >= total - 1}
              className="flex h-7 w-7 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <ChevronRight size={17} />
            </button>
            {/* The rationale for this living in the masthead is on the `onMarkAllRead`
                prop, which does not change with how the button is rendered. */}
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
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Check size={15} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>

      {/*
        The rail, on its own row under search. Inset to the list's own padding; the
        fades and step chevrons dissolve into the list's surface.
      */}
      <FilterStrip
        pills={pills}
        activeFilters={activeFilters as FilterId[]}
        onToggle={onToggleFilter}
        onMute={onMute}
        onRestore={onRestoreFilter}
        onClear={onClearFilters}
        tone="surface"
        className="mx-2.5 pb-1"
      />
    </header>
  );
}

/**
 * The desktop list's header: search across the full width of the list column with
 * where you are in the list beside it, then the filter rail on its own row.
 *
 * The smart filters are the rail (`FilterStrip`), not sidebar rows: coloured pills with
 * their counts, ranked by the store, fading into a step chevron at either edge. It has
 * the list column's full width to itself, so the search field can never sit over its
 * last tab. Folders and the account are the sidebar's (`MailNav.tsx`), an overlay the
 * toggle at the head of this row opens.
 */

import { Check, ChevronLeft, ChevronRight, Search, SquarePen } from "lucide-react";
import { AppMark } from "../AppMark";
import { shortcutFor, shortcutHint } from "../../core/mail/keybinds";
import { FilterStrip, type PillItem } from "./FilterStrip";
import type { FilterId } from "../../core/model/signals";

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
  /** Whether the sidebar overlay is open, for the toggle's `aria-expanded`. */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  pills: PillItem[];
  activeFilters: readonly FilterId[];
  onToggleFilter: (id: FilterId) => void;
  onClearFilters: () => void;
  position: number | null;
  total: number;
  /** "Inbox", "From ada@example.com", or "Filtered". Answerable: 40 of what? */
  listTitle: string;
  /**
   * Whether prev/next would move. From the store's `canStep`, which asks the same
   * question the move does, so a chevron is never live at an end or dead mid-list.
   */
  canPrev: boolean;
  canNext: boolean;
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
  /** Open a blank composer. Absent, the button is not drawn. */
  onCompose?: () => void;
};

/**
 * Where you are in the list: "12 of 39" for the open message's row (or, with nothing
 * open, the cursor's), and just the total when there is no such row — before the first
 * move, or while the open message is not in the visible list. It used to be "— / 39" — a dash standing in for a number, then a slash
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
  sidebarOpen,
  onToggleSidebar,
  pills,
  activeFilters,
  onToggleFilter,
  onClearFilters,
  position,
  total,
  listTitle,
  canPrev,
  canNext,
  onPrev,
  onNext,
  onMarkAllRead,
  onCompose,
}: MastheadProps) {
  return (
    // No `border-b`, no `bg-chrome`: the header is the same surface as the list below
    // it, separated by nothing but the change in what the two contain.
    <header data-masthead="" className="relative z-20 shrink-0">
      <div className="flex h-14 min-w-0 items-center gap-3 px-4">
        {/*
          The sidebar's toggle, at the edge the sidebar slides in from. It wears the app
          mark (the one the phone's top bar shows) rather than a generic panel icon, so
          the corner says whose app this is; hover and press are a quiet surface tint
          behind the mark, never a recolour of it.
        */}
        <button
          type="button"
          data-sidebar-toggle=""
          onClick={onToggleSidebar}
          aria-expanded={sidebarOpen}
          aria-controls="winnow-sidebar"
          aria-haspopup="dialog"
          aria-label="Open sidebar"
          title="Sidebar"
          className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-ctl transition-colors hover:bg-surface-hover active:bg-surface-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <AppMark size={32} />
        </button>
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
              disabled={!canPrev}
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <ChevronLeft size={17} />
            </button>
            <button
              type="button"
              onClick={onNext}
              aria-label="Next message"
              disabled={!canNext}
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
        {/*
          Compose, at the row's far end: the one action here that makes something rather
          than looking at what is there. Accent-filled like Send, which is where it leads.
          The label drops below `lg`, where the list column is narrow and the icon and its
          tooltip say the same.
        */}
        {onCompose && (
          <button
            type="button"
            data-compose=""
            onClick={onCompose}
            aria-label="Compose"
            title={shortcutHint("Compose", "compose")}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-ctl bg-accent px-2.5 text-ui font-semibold text-on-accent transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring lg:px-3.5"
          >
            <SquarePen size={16} strokeWidth={2} aria-hidden="true" />
            <span className="hidden lg:inline">Compose</span>
          </button>
        )}
      </div>

      {/*
        The rail, on its own row under search. Inset to the list's own padding; the
        fades and step chevrons dissolve into the list's surface.
      */}
      <FilterStrip
        pills={pills}
        activeFilters={activeFilters as FilterId[]}
        onToggle={onToggleFilter}
        onClear={onClearFilters}
        tone="surface"
        className="mx-2.5 pb-1"
      />
    </header>
  );
}

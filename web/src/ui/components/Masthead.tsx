/**
 * The desktop list's header: search across the full width of the list column with
 * where you are in the list beside it, then the filter rail on its own row.
 *
 * It floats over the list, like the phone's dock: the top row is a rounded glass bar
 * (`.wn-glass.wn-glass-bar`) inset from the pane's edges, each smart-filter chip is its
 * own glass pill (`FilterStrip` `floating`), and there is no band behind either, so the
 * list scrolls visibly underneath. The header itself takes no pointer events; only the
 * bar, the chips and the slot below them (`below`, the selection bar) do. The list pads
 * its top by the header's measured height (`MessageList` `topInset`).
 *
 * The smart filters are the rail (`FilterStrip`), not sidebar rows: coloured pills with
 * their counts, ranked by the store, fading into a step chevron at either edge. It has
 * the list column's full width to itself, so the search field can never sit over its
 * last tab. Folders and the account are the sidebar's (`MailNav.tsx`), an overlay the
 * toggle at the head of this row opens.
 */

import { ChevronLeft, ChevronRight, PanelLeft, Search, SquarePen } from "lucide-react";
import { AppMark } from "../AppMark";
import { VERSION_TOGGLE_LABEL, logoPressed, versionText, type LogoView } from "../logoVersion";
import { shortcutHint } from "../../core/mail/keybinds";
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
  /** The build's version, from the platform; null until it has said. */
  version: string | null;
  /** Whether the bar shows search or the version (`logoVersion.ts`). */
  logoView: LogoView;
  /** The mark was clicked. */
  onToggleLogo: () => void;
  /** Search was focused some other way: it shows search again. */
  onSearchFocus: () => void;
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
  /** Open a blank composer. Absent, the button is not drawn. */
  onCompose?: () => void;
  /**
   * Shown instead of the chips while there is a multi-selection: the selection bar, so
   * its actions float with the rest of the header and stay in reach however far down
   * the list the selection was made, and the header keeps its height.
   */
  replaceRail?: React.ReactNode;
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
  version,
  logoView,
  onToggleLogo,
  onSearchFocus,
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
  onCompose,
  replaceRail,
}: MastheadProps) {
  return (
    // No band at all: the header floats over the list, and only its glass takes events.
    <header data-masthead="" data-floating="" className="pointer-events-none flex flex-col gap-1 px-2.5 pt-2.5">
      <div
        data-masthead-bar=""
        className="wn-glass wn-glass-bar pointer-events-auto flex h-[52px] min-w-0 items-center gap-3 rounded-full pl-2 pr-2"
      >
        {/*
          The sidebar's toggle, at the edge the sidebar slides in from: a panel icon now,
          since the mark beside it has a job of its own. Hover and press are a quiet
          surface tint, never a recolour.
        */}
        <button
          type="button"
          data-sidebar-toggle=""
          onClick={onToggleSidebar}
          aria-expanded={sidebarOpen}
          aria-controls="winnow-sidebar"
          aria-haspopup="dialog"
          aria-label="Open sidebar"
          title={shortcutHint("Sidebar", "toggleSidebar")}
          aria-keyshortcuts="["
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover hover:text-ink active:bg-surface-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <PanelLeft size={17} strokeWidth={1.9} aria-hidden="true" />
        </button>
        {/*
          The mark is the version toggle (`logoVersion.ts`): a click swaps search for
          "Winnow 1.2.2", a second click (or `/`, or focusing search) brings it back.
        */}
        <button
          type="button"
          data-version-toggle=""
          aria-pressed={logoPressed(logoView)}
          aria-label={VERSION_TOGGLE_LABEL}
          title={VERSION_TOGGLE_LABEL}
          onClick={onToggleLogo}
          className="-ml-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-surface-hover active:bg-surface-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <AppMark size={30} />
        </button>
        {/* Search takes the width; where-you-are keeps its own. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div data-masthead-swap="" data-logo-view={logoView} className="wn-logo-swap min-w-0 flex-1">
          <label
            htmlFor="winnow-search"
            data-shown={logoView === "search" ? "" : undefined}
            /*
              Focus is drawn on the *label*, not the input, via `focus-within`: the
              input is a bare text box inside a rounded field, so an outline on it would
              be a rectangle floating inside a pill.

              The app's `ring` utility is deliberately not used here, because `ring-2`
              composes `box-shadow` out of custom properties and silently resolves to
              `none` on some elements; see the note in `index.css`.
            */
            // Solid, inside the glass: typed text and the placeholder never sit over
            // moving mail.
            className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-edge bg-canvas px-3.5 transition-colors focus-within:bg-surface-active focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--wn-focusRing)]"
          >
            <Search size={14} className="shrink-0 text-ink-placeholder" aria-hidden="true" />
            <input
              id="winnow-search"
              ref={searchRef}
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              onFocus={onSearchFocus}
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent text-ui font-medium text-ink outline-none placeholder:text-ink-placeholder"
            />
          </label>
          <p
            data-version-text=""
            data-shown={logoView === "version" ? "" : undefined}
            aria-live="polite"
            className="truncate px-1 text-ui font-semibold text-ink"
          >
            {logoView === "version" ? versionText(version) : ""}
          </p>
          </div>

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
              className="ml-1 flex h-8 w-8 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <ChevronLeft size={17} />
            </button>
            <button
              type="button"
              onClick={onNext}
              aria-label="Next message"
              disabled={!canNext}
              className="flex h-8 w-8 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <ChevronRight size={17} />
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
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 text-ui font-semibold text-on-accent transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring lg:px-3.5"
          >
            <SquarePen size={16} strokeWidth={2} aria-hidden="true" />
            <span className="hidden lg:inline">Compose</span>
          </button>
        )}
      </div>

      {/*
        The rail, on its own row under the bar: each chip its own floating glass pill,
        with no band behind them. Held at one height, so the selection bar that stands
        in for it while rows are selected does not move the list.
      */}
      <div data-masthead-rail="" className="flex h-11 min-w-0 items-center">
        {replaceRail ?? (
          <FilterStrip
            pills={pills}
            activeFilters={activeFilters as FilterId[]}
            onToggle={onToggleFilter}
            onClear={onClearFilters}
            floating
            className="min-w-0 flex-1"
          />
        )}
      </div>
    </header>
  );
}

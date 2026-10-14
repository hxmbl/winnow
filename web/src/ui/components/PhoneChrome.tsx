/**
 * The phone layout's chrome: a top bar and a bottom dock.
 *
 * Below `sm` the masthead is replaced rather than squeezed. Everything a thumb does often
 * — switching mailbox, narrowing by a stream, opening Settings — moves to the bottom of
 * the screen, and the top keeps what is read rather than tapped: the mark, search, and
 * the account.
 *
 * Flat on purpose, the same way the desktop chrome is: the bars are the canvas tone and
 * the list is the surface tone, so the boundary is a change in value with no rule, no
 * outline and no shadow. Every control is sized for a thumb, and nothing is revealed by
 * hover.
 */

import { Archive, Check, ChevronLeft, ChevronRight, Inbox, Menu, Search, Send, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppMark } from "../AppMark";
import { FilterStrip, type PillItem } from "./FilterStrip";
import { PositionReadout } from "./Masthead";
import type { BuiltinSmartFilter, FilterId } from "../../core/model/signals";
import type { Mailbox } from "../../core/model/email";

const ROUND_BUTTON =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors active:bg-surface-active disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

/** The canvas-toned sheet both bottom bars sit on: this dock and the reader's. */
export const DOCK_SURFACE =
  "relative z-20 shrink-0 rounded-t-pane bg-canvas pb-[max(0.375rem,env(safe-area-inset-bottom))] pt-2";

// ── Top bar ─────────────────────────────────────────────────────────────────

export type PhoneTopBarProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  /** The same ref the keyboard handler focuses on `/`. See `Masthead`. */
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** Signed-in address, or null in the demo. Decides what the trailing circle shows. */
  accountEmail: string | null;
  onOpenNavigation: () => void;
  navigationOpen: boolean;
  listTitle: string;
  position: number | null;
  total: number;
  cursorIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onMarkAllRead: () => void;
};

export function PhoneTopBar({
  searchQuery,
  onSearchChange,
  searchRef,
  accountEmail,
  onOpenNavigation,
  navigationOpen,
  listTitle,
  position,
  total,
  cursorIndex,
  onPrev,
  onNext,
  onMarkAllRead,
}: PhoneTopBarProps) {
  const initial = accountEmail ? (accountEmail.trim()[0] ?? "?").toUpperCase() : null;

  return (
    <header
      data-phone-topbar=""
      className="relative z-30 shrink-0 px-3 pt-[max(0.5rem,env(safe-area-inset-top))]"
    >
      <div className="flex items-center gap-2">
        {/* The mark. Not a button: on a phone the menu is the circle on the right, and
            two controls that open the same drawer would be one too many. */}
        <span data-phone-mark="" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-ctl bg-surface">
          <AppMark size={28} />
          <span className="sr-only">Winnow</span>
        </span>

        <label
          htmlFor="winnow-search"
          className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-ctl bg-surface px-4 transition-colors focus-within:bg-surface-active focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--wn-focusRing)]"
        >
          <Search size={16} className="shrink-0 text-ink-placeholder" aria-hidden="true" />
          <input
            id="winnow-search"
            ref={searchRef}
            type="search"
            enterKeyHint="search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search"
            // 16px: iOS zooms the page into any focused field smaller than that.
            className="min-w-0 flex-1 bg-transparent text-read font-medium text-ink outline-none placeholder:text-ink-placeholder"
          />
        </label>

        {/*
          The account, which is also the menu: the drawer it opens holds the account,
          sign-in and sign-out, every mailbox (Trash and Spam included, which the dock has
          no room for) and Sync. In the demo there is no account, so it is a menu glyph.
        */}
        <button
          type="button"
          onClick={onOpenNavigation}
          aria-expanded={navigationOpen}
          aria-haspopup="dialog"
          aria-label="Open navigation"
          title={accountEmail ?? "Navigation"}
          className={`${ROUND_BUTTON} bg-surface`}
        >
          {accountEmail ? (
            <span
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center rounded-ctl bg-surface-active text-ui font-semibold text-ink-body"
            >
              {initial}
            </span>
          ) : (
            <Menu size={19} strokeWidth={1.9} aria-hidden="true" />
          )}
        </button>
      </div>

      {/*
        What you are looking at, and the two list-wide controls. The same cluster the
        masthead carries, at touch size; the title is a `span[title]` there too.
      */}
      <div className="flex items-center gap-1 pb-1 pl-2 pt-1.5">
        <span className="min-w-0 truncate text-read font-semibold text-ink" title={listTitle}>
          {listTitle}
        </span>
        <PositionReadout position={position} total={total} className="ml-2 shrink-0" />
        <span className="flex-1" />
        <button type="button" onClick={onPrev} aria-label="Previous message" disabled={cursorIndex <= 0} className={ROUND_BUTTON}>
          <ChevronLeft size={19} />
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next message"
          disabled={total === 0 || cursorIndex >= total - 1}
          className={ROUND_BUTTON}
        >
          <ChevronRight size={19} />
        </button>
        <button type="button" onClick={onMarkAllRead} aria-label="Mark all read" title="Mark all read" disabled={total === 0} className={ROUND_BUTTON}>
          <Check size={18} strokeWidth={2} />
        </button>
      </div>
    </header>
  );
}

// ── Dock ────────────────────────────────────────────────────────────────────

/** The four tabs. Trash and Spam stay in the drawer. */
const TABS: readonly { id: Mailbox | "settings"; label: string; Icon: LucideIcon }[] = [
  { id: "inbox", label: "Inbox", Icon: Inbox },
  { id: "sent", label: "Sent", Icon: Send },
  { id: "archive", label: "Archive", Icon: Archive },
  { id: "settings", label: "Settings", Icon: Settings },
];

export type PhoneDockProps = {
  pills: PillItem[];
  activeFilters: FilterId[];
  onToggleFilter: (id: FilterId) => void;
  onMute: (id: BuiltinSmartFilter) => void;
  onRestoreFilter: (id: BuiltinSmartFilter) => void;
  onClearFilters: () => void;
  mailbox: Mailbox;
  /** Unread per mailbox, for the tab's accessible name and its quiet count. */
  unread: Partial<Record<Mailbox, number>>;
  onSelectMailbox: (mailbox: Mailbox) => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
};

export function PhoneDock({
  pills,
  activeFilters,
  onToggleFilter,
  onMute,
  onRestoreFilter,
  onClearFilters,
  mailbox,
  unread,
  onSelectMailbox,
  settingsOpen,
  onOpenSettings,
}: PhoneDockProps) {
  return (
    /*
      One surface. The streams and the tabs are not two bars stacked on each other: they
      share a single canvas-toned sheet with rounded top corners, and the only thing
      between them is spacing.
    */
    <div data-phone-dock="" className={DOCK_SURFACE}>
      {/* The streams and smart filters, just above the tabs where a thumb rests. */}
      <FilterStrip
        pills={pills}
        activeFilters={activeFilters}
        onToggle={onToggleFilter}
        onMute={onMute}
        onRestore={onRestoreFilter}
        onClear={onClearFilters}
        touch
        className="px-3"
      />

      <nav aria-label="Primary" className="mt-1.5 grid grid-cols-4 gap-1 px-2">
        {TABS.map(({ id, label, Icon }) => {
          const current = id === "settings" ? settingsOpen : !settingsOpen && mailbox === id;
          const count = id === "settings" ? 0 : (unread[id] ?? 0);
          return (
            <button
              key={id}
              type="button"
              aria-current={current ? "page" : undefined}
              aria-label={count > 0 ? `${label}, ${count} unread` : label}
              onClick={() => (id === "settings" ? onOpenSettings() : onSelectMailbox(id))}
              className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 rounded-pane px-1 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                current ? "bg-sheen text-ink" : "text-ink-muted active:bg-sheen"
              }`}
            >
              <span className="relative">
                <Icon size={20} strokeWidth={current ? 2.1 : 1.8} aria-hidden="true" />
                {count > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -right-3 -top-1.5 min-w-[1.1rem] rounded-ctl bg-surface px-1 text-center text-meta font-semibold leading-[1.45] tabular-nums text-ink-body"
                  >
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </span>
              <span className={`text-meta ${current ? "font-semibold" : "font-medium"}`}>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

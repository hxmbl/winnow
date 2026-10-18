/**
 * The phone layout's chrome: a top bar and a bottom dock.
 *
 * Below `sm` the masthead is replaced rather than squeezed. Everything a thumb does often
 * — narrowing by a smart filter, switching mailbox, opening the menu, opening Settings —
 * is at the bottom of the screen: the swipeable filter chips sit just above the four
 * tabs (Inbox, Sent, Archive, Settings), and a second tap on Inbox raises the menu
 * (`MailNav.tsx`, every folder and the account) as a sheet from the dock.
 * The top is only where you are and search: the mark, the list's name and count, and
 * the search field under them.
 *
 * Flat on purpose, the same way the desktop chrome is: the bars are the canvas tone and
 * the list is the surface tone, so the boundary is a change in value with no rule, no
 * outline and no shadow. Every control is sized for a thumb, and nothing is revealed by
 * hover.
 */

import { useLayoutEffect, useRef } from "react";
import { Archive, Inbox, Search, Send, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppMark } from "../AppMark";
import { FilterStrip, type PillItem } from "./FilterStrip";
import { PositionReadout } from "./Masthead";
import type { FilterId } from "../../core/model/signals";
import type { Mailbox } from "../../core/model/email";
import { PHONE_TABS_VAR, inboxTabAction, inboxTabLabel } from "../phoneDock";

/** The canvas-toned sheet both bottom bars sit on: this dock and the reader's. */
export const DOCK_SURFACE =
  "relative z-20 shrink-0 rounded-t-pane border-t border-edge bg-canvas pb-[max(0.375rem,env(safe-area-inset-bottom))] pt-2";

// ── Top bar ─────────────────────────────────────────────────────────────────

export type PhoneTopBarProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  /** The same ref the keyboard handler focuses on `/`. See `Masthead`. */
  searchRef: React.RefObject<HTMLInputElement | null>;
  listTitle: string;
  position: number | null;
  total: number;
};

export function PhoneTopBar({ searchQuery, onSearchChange, searchRef, listTitle, position, total }: PhoneTopBarProps) {
  return (
    <header
      data-phone-topbar=""
      className="relative z-30 shrink-0 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]"
    >
      {/*
        Where you are: the mark, then the list's name and how many conversations are in
        it. No list-wide buttons up here: the phone list has no cursor to step through,
        there is no Mark all read, and the menu is a second tap on Inbox.
        The title is a `span[title]`, as in the masthead.
      */}
      <div className="flex min-h-11 items-center gap-3">
        <span data-phone-mark="" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-ctl bg-surface">
          <AppMark size={28} />
          <span className="sr-only">Winnow</span>
        </span>
        <span className="min-w-0 truncate text-title font-semibold tracking-[-0.01em] text-ink" title={listTitle}>
          {listTitle}
        </span>
        <PositionReadout position={position} total={total} className="shrink-0 pt-1" />
      </div>

      {/*
        Search has the whole width to itself, on its own row: a field as wide as the
        screen reads as the place to type, where one squeezed between two buttons read
        as a third button.
      */}
      <label
        htmlFor="winnow-search"
        data-phone-search=""
        className="mt-2 flex h-11 min-w-0 items-center gap-2.5 rounded-ctl bg-surface px-3.5 transition-colors focus-within:bg-surface-active focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--wn-focusRing)]"
      >
        <Search size={17} className="shrink-0 text-ink-placeholder" aria-hidden="true" />
        <input
          id="winnow-search"
          ref={searchRef}
          type="search"
          enterKeyHint="search"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search mail"
          // 16px: iOS zooms the page into any focused field smaller than that.
          className="min-w-0 flex-1 bg-transparent text-read text-ink outline-none placeholder:text-ink-placeholder"
        />
      </label>
    </header>
  );
}

// ── Dock ────────────────────────────────────────────────────────────────────

/** The four tabs. Trash and Spam are in the menu. */
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
  onClearFilters: () => void;
  mailbox: Mailbox;
  /** Unread per mailbox, for the tab's accessible name and its quiet count. */
  unread: Partial<Record<Mailbox, number>>;
  onSelectMailbox: (mailbox: Mailbox) => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  /** The menu (the sidebar), which the Inbox tab opens on its second tap. */
  menuOpen: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
};

export function PhoneDock({
  pills,
  activeFilters,
  onToggleFilter,
  onClearFilters,
  mailbox,
  unread,
  onSelectMailbox,
  settingsOpen,
  onOpenSettings,
  menuOpen,
  onOpenMenu,
  onCloseMenu,
}: PhoneDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLElement>(null);

  // Publish where the tabs start, measured from the window's bottom edge, for the menu
  // sheet to sit on. Watched, because the safe area and the chip row's height can both
  // change without a re-render.
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const tabs = tabsRef.current;
    if (!dock || !tabs) return;
    const root = document.documentElement;
    let last = "";
    const measure = () => {
      const value = `${Math.max(0, Math.round(window.innerHeight - tabs.getBoundingClientRect().top))}px`;
      if (value === last) return;
      last = value;
      root.style.setProperty(PHONE_TABS_VAR, value);
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(dock);
    observer?.observe(tabs);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      root.style.removeProperty(PHONE_TABS_VAR);
    };
  }, []);

  return (
    /*
      One surface. The filter chips and the tabs are not two bars stacked on each other:
      they share a single canvas-toned sheet with rounded top corners, and the only thing
      between them is spacing.

      While the menu is open the dock stays above the scrim and live, so the tab that
      opened the menu is the one that closes it; the menu sheet covers the chip row,
      which is set aside (hidden and inert) until it closes.
    */
    <div
      ref={dockRef}
      data-phone-dock=""
      data-menu-open={menuOpen ? "" : undefined}
      className={DOCK_SURFACE}
      // Over the scrim (z-40), under the sheet (z-50).
      style={menuOpen ? { zIndex: 45 } : undefined}
    >
      {/* The smart filters, just above the tabs where a thumb rests. */}
      <div inert={menuOpen} className={menuOpen ? "invisible" : undefined}>
        <FilterStrip
          pills={pills}
          activeFilters={activeFilters}
          onToggle={onToggleFilter}
          onClear={onClearFilters}
          touch
          className="px-3"
        />
      </div>

      <nav ref={tabsRef} aria-label="Primary" className="mt-1.5 grid grid-cols-4 gap-1 px-2">
        {TABS.map(({ id, label, Icon }) => {
          const current = id === "settings" ? settingsOpen : !settingsOpen && mailbox === id;
          const count = id === "settings" ? 0 : (unread[id] ?? 0);
          const isInbox = id === "inbox";
          // Inbox is two things: the mailbox on the first tap, and once it is the
          // current tab, the menu's toggle.
          const toggles = isInbox && (current || menuOpen);
          const onClick = () => {
            if (isInbox) {
              const action = inboxTabAction(current, menuOpen);
              if (action === "close-menu") onCloseMenu();
              else if (action === "open-menu") onOpenMenu();
              else onSelectMailbox("inbox");
              return;
            }
            if (menuOpen) onCloseMenu();
            if (id === "settings") onOpenSettings();
            else onSelectMailbox(id);
          };
          return (
            <button
              key={id}
              type="button"
              // Where focus goes back to when the menu closes (see `Sidebar`).
              data-sidebar-toggle={isInbox ? "" : undefined}
              aria-current={current ? "page" : undefined}
              aria-label={isInbox ? inboxTabLabel(count, current, menuOpen) : count > 0 ? `${label}, ${count} unread` : label}
              aria-haspopup={toggles ? "dialog" : undefined}
              aria-expanded={toggles ? menuOpen : undefined}
              aria-controls={toggles ? "winnow-sidebar" : undefined}
              onClick={onClick}
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

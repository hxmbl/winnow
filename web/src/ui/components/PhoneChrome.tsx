/**
 * The phone layout's chrome: a top bar and a bottom dock.
 *
 * Below `sm` the masthead is replaced rather than squeezed. Everything a thumb does often
 * — narrowing by a smart filter, switching mailbox, opening the menu, composing — is at
 * the bottom of the screen, floating over the list rather than taking a bar from it
 * (after Linear's Android app): a rounded glass pill of icon-only tabs (Inbox, Sent)
 * ending in an Expand chevron, the compose button as its own circle beside it, and the
 * smart-filter chips floating one by one just above, and, once the list is a screen
 * down, a small "Top" pill centred above those. Expand grows the pill upward into
 * the menu panel (`MailNav.tsx`: every folder and the account, whose gear is the way
 * into Settings).
 * The top is one row: the mark and, beside it, search, whose placeholder names the list
 * ("Search Inbox"); the list's name and count are a visually hidden heading.
 *
 * The top floats too: the mark and the search pill are each their own glass over the
 * list, with no band behind them, and the mark is the version toggle (`logoVersion.ts`).
 * Light frost, a hairline and a soft shadow (`glass.ts`), with the list scrolling
 * visibly underneath top and bottom. Every control is sized for a thumb, and nothing is
 * revealed by hover.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronsDownUp, ChevronsUpDown, Inbox, Search, Send } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppMark } from "../AppMark";
import { FilterStrip, type PillItem } from "./FilterStrip";
import { PositionReadout } from "./Masthead";
import type { FilterId } from "../../core/model/signals";
import type { Mailbox } from "../../core/model/email";
import { ComposeButton } from "./ComposeFab";
import { listScroller, scrollListToTop } from "../listScroll";
import { VERSION_TOGGLE_LABEL, logoHaptic, logoPressed, versionText, type LogoView } from "../logoVersion";
import {
  BACK_TO_TOP_LABEL,
  DOCK_TABS,
  EXPAND_LABEL,
  PHONE_DOCK_VAR,
  PHONE_TABS_VAR,
  backToTopVisible,
  badgeText,
  tabAction,
  tabLabel,
} from "../phoneDock";

/** The canvas-toned sheet the reader's bottom bar sits on. */
export const DOCK_SURFACE =
  "relative z-20 shrink-0 rounded-t-pane border-t border-edge bg-canvas pb-[max(0.375rem,env(safe-area-inset-bottom))] pt-2";

// ── Top bar ─────────────────────────────────────────────────────────────────

export type PhoneTopBarProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  /** The same ref the keyboard handler focuses on `/`. See `Masthead`. */
  searchRef: React.RefObject<HTMLInputElement | null>;
  listTitle: string;
  /**
   * The mailbox being searched, for the field's placeholder ("Search Inbox"). Not the
   * list title, which under a smart filter is the filter's name ("Urgent", "Filtered").
   */
  mailboxName: string;
  position: number | null;
  total: number;
  /** The build's version, from the platform; null until it has said. */
  version: string | null;
  /** Whether the field shows search or the version (`logoVersion.ts`). */
  logoView: LogoView;
  /** The mark was tapped. */
  onToggleLogo: () => void;
  /** Search was focused some other way: it shows search again. */
  onSearchFocus: () => void;
};

export function PhoneTopBar({
  searchQuery,
  onSearchChange,
  searchRef,
  listTitle,
  mailboxName,
  position,
  total,
  version,
  logoView,
  onToggleLogo,
  onSearchFocus,
}: PhoneTopBarProps) {
  const showVersion = logoView === "version";
  return (
    /*
      Floating over the list, like the dock: no band behind it, so the mail scrolls up
      visibly under the mark and the search pill, each its own glass (`.wn-glass`). The
      header takes no taps; only the mark and the field do. The list pads its top by the
      bar's measured height, so the first row still clears it at rest.
    */
    <header
      data-phone-topbar=""
      data-floating=""
      className="pointer-events-none relative shrink-0 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]"
    >
      {/*
        One row: the mark, then search beside it, taking the rest of the width. There is
        no big "Inbox 39" title row any more, so the mail starts higher; where you are is
        said by the dock's current tab, by search's own placeholder ("Search Inbox"), and
        to a screen reader by the visually hidden heading below, which carries the list's
        name and count. No list-wide buttons up here: the phone list has no cursor to step
        through, there is no Mark all read, and the menu is the dock's Expand button.
        The name is a `span[title]` inside that heading, as in the masthead.
      */}
      <h1 className="sr-only">
        <span title={listTitle}>{listTitle}</span>, <PositionReadout position={position} total={total} />{" "}
        {total === 1 ? "conversation" : "conversations"}
      </h1>
      <div className="flex min-h-11 items-center gap-2">
        {/*
          The mark is the version toggle: a tap swaps search for "Winnow 1.2.2" (with a
          small haptic tick), a second tap brings search back.
        */}
        <button
          type="button"
          data-phone-mark=""
          data-version-toggle=""
          aria-pressed={logoPressed(logoView)}
          aria-label={VERSION_TOGGLE_LABEL}
          title={VERSION_TOGGLE_LABEL}
          onClick={() => {
            const tick = logoHaptic(true);
            if (tick) navigator.vibrate?.(tick);
            onToggleLogo();
          }}
          className="wn-glass pointer-events-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <AppMark size={28} />
        </button>
        <div
          data-phone-search=""
          data-logo-view={logoView}
          className="wn-glass wn-glass-bar wn-logo-swap pointer-events-auto h-11 min-w-0 flex-1 rounded-full focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--wn-focusRing)]"
        >
          <label
            htmlFor="winnow-search"
            data-shown={showVersion ? undefined : ""}
            className="flex h-11 min-w-0 items-center gap-2.5 px-3.5"
          >
            <Search size={17} className="shrink-0 text-ink-placeholder" aria-hidden="true" />
            <input
              id="winnow-search"
              ref={searchRef}
              type="search"
              enterKeyHint="search"
              value={searchQuery}
              onChange={(event) => onSearchChange(event.target.value)}
              onFocus={onSearchFocus}
              placeholder={`Search ${mailboxName}`}
              // 16px: iOS zooms the page into any focused field smaller than that.
              className="min-w-0 flex-1 bg-transparent text-read text-ink outline-none placeholder:text-ink-placeholder"
            />
          </label>
          <p
            data-version-text=""
            data-shown={showVersion ? "" : undefined}
            aria-live="polite"
            className="truncate px-4 text-read font-semibold text-ink"
          >
            {showVersion ? versionText(version) : ""}
          </p>
        </div>
      </div>
    </header>
  );
}

// ── Dock ────────────────────────────────────────────────────────────────────

/**
 * The two tabs. Archive, Trash, Spam and Drafts are in the panel behind Expand, and so
 * is Settings, behind the gear on the account row: opened rarely, so none earns a tab.
 */
const TAB_ICON: Record<(typeof DOCK_TABS)[number], { label: string; Icon: LucideIcon }> = {
  inbox: { label: "Inbox", Icon: Inbox },
  sent: { label: "Sent", Icon: Send },
};

/** The soft circle under the current tab, and under Expand while the panel is open. */
const HIGHLIGHT = "bg-[color-mix(in_srgb,var(--wn-ink)_9%,transparent)]";

export type PhoneDockProps = {
  pills: PillItem[];
  activeFilters: FilterId[];
  onToggleFilter: (id: FilterId) => void;
  onClearFilters: () => void;
  mailbox: Mailbox;
  /** Unread per mailbox, for the tab's accessible name and its badge. */
  unread: Partial<Record<Mailbox, number>>;
  onSelectMailbox: (mailbox: Mailbox) => void;
  /** Settings is open over the list: no mailbox tab is the current page then. */
  settingsOpen: boolean;
  /** The menu panel, which Expand grows out of the pill. */
  menuOpen: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  /** Compose, or null while composing makes no sense (a selection, Settings, a sheet). */
  onCompose: (() => void) | null;
  /**
   * Whether the back-to-top pill may show at all: not during a multi-selection, an
   * overlay (Settings, the palette, the shortcut sheet) or the composer. The panel being
   * expanded is the dock's own `menuOpen`.
   */
  backToTopAllowed?: boolean;
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
  menuOpen,
  onOpenMenu,
  onCloseMenu,
  onCompose,
  backToTopAllowed = true,
}: PhoneDockProps) {
  const dockRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const topSlotRef = useRef<HTMLDivElement>(null);

  /*
    The back-to-top pill follows the list's scroll. One capturing listener on the
    document rather than one on the scroller, because the scroller is replaced whenever
    the empty state comes and goes; re-read when the mailbox or filters change the list
    under it, and when the window resizes.
  */
  const [listDown, setListDown] = useState(false);
  const showTop = listDown && backToTopAllowed && !menuOpen && !settingsOpen;
  const showTopRef = useRef(showTop);
  showTopRef.current = showTop;
  const filterSignature = activeFilters.join("|");
  useEffect(() => {
    const read = () => {
      const scroller = listScroller();
      setListDown(
        scroller !== null &&
          backToTopVisible({ scrollTop: scroller.scrollTop, viewportHeight: scroller.clientHeight, allowed: true, menuOpen: false }),
      );
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof HTMLElement && event.target.matches("[data-row-count]")) read();
    };
    read();
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", read);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", read);
    };
  }, [mailbox, filterSignature]);
  const measureRef = useRef<() => void>(() => undefined);

  // Publish, measured from the window's bottom edge: where the pill starts (Settings'
  // sheet stops there) and where the floating chrome starts (the list pads its end by
  // that much). Watched, because the safe area and the chip row can both change without
  // a re-render.
  useLayoutEffect(() => {
    const dock = dockRef.current;
    const pill = pillRef.current;
    if (!dock || !pill) return;
    const root = document.documentElement;
    let last = "";
    const measure = () => {
      const height = window.innerHeight;
      const pillTop = pill.getBoundingClientRect().top;
      const chips = chipsRef.current;
      // While the back-to-top pill shows, the floating chrome starts at its slot, so the
      // last row scrolls clear of it too; hidden, it covers nothing and counts for nothing.
      const slot = topSlotRef.current;
      const chromeTop =
        showTopRef.current && slot
          ? slot.getBoundingClientRect().top
          : chips && chips.getClientRects().length > 0
            ? chips.getBoundingClientRect().top
            : pillTop;
      const tabs = `${Math.max(0, Math.round(height - pillTop))}px`;
      const chrome = `${Math.max(0, Math.round(height - chromeTop))}px`;
      if (`${tabs}|${chrome}` === last) return;
      last = `${tabs}|${chrome}`;
      root.style.setProperty(PHONE_TABS_VAR, tabs);
      root.style.setProperty(PHONE_DOCK_VAR, chrome);
    };
    measure();
    measureRef.current = measure;
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(dock);
    observer?.observe(pill);
    if (chipsRef.current) observer?.observe(chipsRef.current);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      root.style.removeProperty(PHONE_TABS_VAR);
      root.style.removeProperty(PHONE_DOCK_VAR);
    };
  }, []);

  const scrollToTop = scrollListToTop;

  // The clearance follows the pill showing and hiding.
  useLayoutEffect(() => {
    measureRef.current();
  }, [showTop]);

  return (
    /*
      Floating over the list, not a bar under it: the dock itself is transparent and lets
      touches through (`pointer-events-none`); only the chips, the pill and the compose
      button take them. The list runs all the way to the bottom edge and scrolls visibly
      underneath, padded at its end by `--wn-phone-dock`.

      While Settings is open on a phone the dock rises over its sheet (z 55), chips hidden.
      While the menu is open the dock rises over the scrim and the panel (z 55), and of
      the pill only Expand stays, sitting in the panel's bottom row where it was, so the
      chevron that opened the panel is the one that closes it. The chips are set aside
      (hidden and inert) until it closes.
    */
    <div
      ref={dockRef}
      data-phone-dock=""
      data-menu-open={menuOpen ? "" : undefined}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30"
      // Over the open menu, and over Settings, which fills the screen behind the dock so
      // its tabs (any of them leaves Settings) stay on top; under the sheet's z-50 they
      // were covered.
      style={menuOpen || settingsOpen ? { zIndex: 55 } : undefined}
    >
      {/*
        Back to top: a small glass pill centred above the chips, once the list is a screen
        down. The slot always holds its place (so showing it never nudges the chips) but
        takes no taps; hidden, the pill is `visibility: hidden` and out of the tab order,
        and it fades and rises in (`.wn-back-to-top`, instant under reduced motion).
      */}
      <div ref={topSlotRef} data-back-to-top-slot="" className="flex justify-center pb-1.5">
        <button
          type="button"
          data-back-to-top=""
          data-shown={showTop ? "" : undefined}
          aria-label={BACK_TO_TOP_LABEL}
          title={BACK_TO_TOP_LABEL}
          tabIndex={showTop ? undefined : -1}
          onClick={scrollToTop}
          className="wn-glass wn-back-to-top flex h-9 items-center gap-1.5 rounded-full pl-3 pr-3.5 text-ui font-semibold text-ink-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <ArrowUp size={16} strokeWidth={2.2} aria-hidden="true" />
          <span aria-hidden="true">Top</span>
        </button>
      </div>

      {/* The smart filters, floating just above the pill where a thumb rests. */}
      <div
        ref={chipsRef}
        data-phone-chips=""
        data-dock-band=""
        inert={menuOpen || settingsOpen}
        className={`wn-rail-haze mb-1 ${menuOpen || settingsOpen ? "invisible" : ""}`}
      >
        <FilterStrip
          pills={pills}
          activeFilters={activeFilters}
          onToggle={onToggleFilter}
          onClear={onClearFilters}
          touch
        />
      </div>

      <div data-dock-band="" className="flex items-end gap-[var(--wn-dock-gap)] pb-[var(--wn-dock-bottom)] pl-[var(--wn-dock-left)] pr-[var(--wn-dock-right)]">
        <nav
          ref={pillRef}
          aria-label="Primary"
          data-phone-pill=""
          data-expanded={menuOpen ? "" : undefined}
          // Open, the pill is see-through and sits above the panel (z 55 over 50), on the
          // panel's Inbox row: it must not take that row's taps. Only Expand, which keeps
          // its own `pointer-events-auto`, stays live on it.
          className={`wn-glass wn-liquid grid h-[var(--wn-dock-h)] min-w-0 flex-1 grid-cols-3 items-stretch rounded-full px-1.5 transition-[background-color,box-shadow,border-color] duration-200 ${
            menuOpen ? "pointer-events-none" : "pointer-events-auto"
          }`}
        >
          {DOCK_TABS.map((id) => {
            const { label, Icon } = TAB_ICON[id];
            const current = !settingsOpen && mailbox === id;
            const count = unread[id] ?? 0;
            const badge = badgeText(count);
            const onClick = () => {
              if (tabAction(current) === "scroll-top") scrollToTop();
              else onSelectMailbox(id);
            };
            return (
              <button
                key={id}
                type="button"
                data-dock-tab={id}
                aria-current={current ? "page" : undefined}
                aria-label={tabLabel(label, count)}
                tabIndex={menuOpen ? -1 : undefined}
                onClick={onClick}
                className={`group flex min-h-12 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                  menuOpen ? "invisible" : ""
                }`}
              >
                <span
                  className={`relative flex h-12 w-16 items-center justify-center rounded-full transition-colors ${
                    current ? `${HIGHLIGHT} text-ink` : "text-ink-muted group-active:bg-sheen"
                  }`}
                >
                  <Icon size={22} strokeWidth={current ? 2.2 : 1.9} aria-hidden="true" />
                  {badge && (
                    <span
                      aria-hidden="true"
                      data-dock-badge=""
                      className="absolute right-1.5 top-1 min-w-[1.15rem] rounded-full bg-accent px-1 text-center text-meta font-semibold leading-[1.15rem] tabular-nums text-on-accent"
                    >
                      {badge}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            data-dock-expand=""
            // Where focus goes back to when the menu closes (see `Sidebar`).
            data-sidebar-toggle=""
            aria-label={EXPAND_LABEL}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-controls="winnow-sidebar"
            onClick={menuOpen ? onCloseMenu : onOpenMenu}
            className="group pointer-events-auto flex min-h-12 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <span
              className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
                menuOpen ? `${HIGHLIGHT} text-ink` : "text-ink-muted group-active:bg-sheen"
              }`}
            >
              {menuOpen ? (
                <ChevronsDownUp size={22} strokeWidth={1.9} aria-hidden="true" />
              ) : (
                <ChevronsUpDown size={22} strokeWidth={1.9} aria-hidden="true" />
              )}
            </span>
          </button>
        </nav>

        {/*
          The compose button, its own circle beside the pill, the pill's height. When
          composing makes no sense the space stays, so the pill (and the panel it grows
          into) keeps one width.
        */}
        {onCompose ? (
          <ComposeButton
            onCompose={() => {
              if (menuOpen) onCloseMenu();
              onCompose();
            }}
          />
        ) : (
          <span aria-hidden="true" className="h-[var(--wn-dock-h)] w-[var(--wn-dock-h)] shrink-0" />
        )}
      </div>
    </div>
  );
}

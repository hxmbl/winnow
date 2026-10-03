/**
 * The top bar.
 *
 * Four things in a row, in a deliberate order: identity, search, filters,
 * actions. Left to right is "what am I looking at" → "narrow it" → "act on it",
 * and the hairline between the filters and the actions marks exactly that
 * boundary.
 *
 * The filter strip is rendered twice — inline on a wide screen, on its own row
 * on a narrow one — from the same props object. The narrow copy is
 * `aria-hidden`, because two live copies of the same control list in the
 * accessibility tree is a bug: a screen reader user would hear every pill twice
 * and have no way to tell which one responds to Enter.
 */

import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  LogIn,
  Mail,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { formatRelative } from "../../core/mail/datetime";
import type { Mailbox } from "../../core/model/email";
import { FilterStrip, type PillItem } from "./FilterStrip";

export type MailboxTab = { id: Mailbox; label: string; unread: number };

type Props = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  /**
   * The search input's element.
   *
   * A ref, not a "focus token" prop, because `/` has to actually focus this
   * element and nothing else can do it. The keybind handler in `App.tsx` holds
   * the same ref — if the two ever diverge, `/` silently does nothing and every
   * subsequent keystroke is swallowed by the keyboard layer, which is a
   * spectacularly confusing bug to debug.
   */
  searchRef: React.RefObject<HTMLInputElement | null>;
  pills: PillItem[];
  activeFilters: readonly PillItem["id"][];
  onToggleFilter: (id: PillItem["id"]) => void;
  onMute: (id: Parameters<FilterStripProps["onMute"]>[0]) => void;
  /** Undo a mute from the pill that caused it. */
  onRestoreFilter: (id: Parameters<FilterStripProps["onRestore"]>[0]) => void;
  onClearFilters: () => void;
  mailboxes: MailboxTab[];
  activeMailbox: Mailbox;
  onSelectMailbox: (mailbox: Mailbox) => void;
  position: number;
  total: number;
  /**
   * What the list is currently showing: "Inbox", "From ada@example.com", or
   * "Filtered". Shown next to the position so that "3 of 40" is always
   * answerable — 40 of what?
   */
  listTitle: string;
  cursorIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onStar: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onRead: () => void;
  onMarkAllRead: () => void;
  onRefresh: () => void;
  onSettings: () => void;
  syncing: boolean;
  lastSyncedAt: number | null;
  hasSelection: boolean;
  accountEmail: string | null;
  onSignOut: () => void;
  /**
   * Start sign-in, from the demo mailbox.
   *
   * The app boots straight into the demo with no session, so the sign-in *screen* is
   * never what a first-time user sees. Without this button, sign-in is unreachable
   * until you have already signed in — the whole Gmail half of the product, gated
   * behind having used it.
   */
  onSignIn: () => void;
  /** True while the OAuth round trip is in flight. */
  signingIn: boolean;
  /** Why the last attempt failed, or `null`. Rendered beside the button. */
  connectError: string | null;
};

type FilterStripProps = React.ComponentProps<typeof FilterStrip>;

const ICON_BUTTON =
  "flex h-8 w-8 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover disabled:opacity-35 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

/** The action cluster. Disabled rather than hidden when there is no selection. */
function ToolButton({
  onClick,
  label,
  hint,
  disabled,
  children,
}: {
  onClick: () => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // `disabled` and not `aria-disabled`: these buttons do nothing without a
      // selection, and a focusable control that does nothing is worse than one
      // that cannot be reached.
      disabled={disabled}
      aria-label={label}
      title={hint ? `${label} — ${hint}` : label}
      className={ICON_BUTTON}
    >
      {children}
    </button>
  );
}

export function TopBar({
  searchQuery,
  onSearchChange,
  searchRef,
  pills,
  activeFilters,
  onToggleFilter,
  onMute,
  onRestoreFilter,
  onClearFilters,
  mailboxes,
  activeMailbox,
  onSelectMailbox,
  position,
  total,
  listTitle,
  cursorIndex,
  onPrev,
  onNext,
  onStar,
  onArchive,
  onTrash,
  onRead,
  onMarkAllRead,
  onRefresh,
  onSettings,
  syncing,
  lastSyncedAt,
  hasSelection,
  accountEmail,
  onSignOut,
  onSignIn,
  signingIn,
  connectError,
}: Props) {
  const stripProps = {
    pills,
    activeFilters: activeFilters as PillItem["id"][],
    onToggle: onToggleFilter,
    onMute,
    onRestore: onRestoreFilter,
    onClear: onClearFilters,
  };

  // The archive button's meaning follows the mailbox, exactly as the `e`
  // shortcut's does. A toolbar that says "Archive" while you are looking at the
  // bin, and archives something that is already archived, is a small lie.
  const archiveLabel =
    activeMailbox === "inbox"
      ? "Archive"
      : activeMailbox === "archive"
        ? "Move to inbox"
        : "Restore";
  const trashLabel = activeMailbox === "trash" ? "Delete permanently" : "Move to trash";

  return (
    <header className="relative z-30 shrink-0 border-b border-hairline bg-chrome">
      {/*
        Two rows on a narrow screen, one from `sm` up.

        The bar's children are nearly all `shrink-0` — the logo, the mailbox pills, the
        icon buttons, the position cluster — and the only elastic one is the search box,
        which absorbed *all* the shrinkage and collapsed to zero width on a 390px phone.
        Shrinking any one child instead moves the problem rather than fixing it: give
        the mailbox nav a floor and the search vanishes; give the search a floor and the
        row overflows with nothing to scroll.

        So the bar wraps. `flex-wrap` plus `order-last w-full` on the search puts it on
        its own line below `sm` — where a search field wants to be anyway, full width,
        above the rail — and `sm:flex-nowrap sm:order-none` puts it back inline where
        the desktop layout wants it. One element, two layouts, no duplication and no
        fixed-pixel guesses about how tall the chrome is.
      */}
      <div className="flex h-auto min-w-0 flex-wrap items-center gap-2 px-3 py-2 sm:h-14 sm:flex-nowrap sm:gap-3 lg:h-16 lg:px-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center">
          <img src="./relayLight.svg" alt="" aria-hidden="true" className="h-9 w-9" />
          <span className="sr-only">Winnow</span>
        </div>

        {/*
          The mailbox tabs.

          Inline rather than in a permanent sidebar, for a reason that is about
          reading rather than about navigation: a mail client is a full-window
          reading surface, and a folder rail permanently spends ~200px of it on
          four destinations. These four pills cost about 220px but only *while
          the bar is visible*, they sit next to the thing they change, and they
          carry the unread counts that make them worth the space.

          They were previously mobile-only, which left a desktop user with no way
          to reach Archive or Spam except remembering `!` and then the arrows.
        */}
        <nav
          aria-label="Mailboxes"
          // `min-w-0` rather than `shrink-0`: with `shrink-0` the four mailbox pills
          // were immovable, so the search box had nowhere to go and collapsed to zero
          // width on a phone. Allowed to shrink, the nav scrolls internally instead —
          // the same affordance as the filter strip below it, and consistent with it.
          className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto"
        >
          {mailboxes.map((mailbox) => (
            <button
              key={mailbox.id}
              type="button"
              onClick={() => onSelectMailbox(mailbox.id)}
              aria-current={activeMailbox === mailbox.id ? "page" : undefined}
              className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-ui font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                activeMailbox === mailbox.id
                  ? "bg-surface-active text-ink"
                  : "text-ink-muted hover:bg-surface-hover hover:text-ink-body"
              }`}
            >
              {mailbox.label}
              {mailbox.unread > 0 && (
                <span className="rounded-full bg-surface px-1.5 text-[11px] tabular-nums text-ink-muted">
                  {mailbox.unread}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/*
          The search box.

          `min-w-[9.5rem]` is not a style preference. Every other child of this row is
          `shrink-0`, so the search — the one elastic element — absorbed all the
          shrinkage and collapsed to *zero width* on a 390px phone. Not cramped:
          absent, while still occupying a slot and still being focusable by `/`. The
          row scrolls, so a hard minimum keeps it reachable rather than invisible, and
          `max-w-[220px]` still stops it eating the bar on a desktop.
        */}
        <label
          htmlFor="topbar-search"
          className="order-last flex h-8 w-full min-w-0 items-center gap-2 rounded-full border border-hairline bg-surface-sunken px-3 sm:order-none sm:max-w-[220px] sm:flex-1 sm:min-w-[9.5rem]"
        >
          <Search size={14} className="shrink-0 text-ink-placeholder" aria-hidden="true" />
          <input
            id="topbar-search"
            ref={searchRef}
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-ui font-medium text-ink outline-none placeholder:text-ink-placeholder"
          />
        </label>

        {/* The inline strip is the live one; the narrow copy below is decorative
            for sighted users and hidden from assistive tech entirely. */}
        <FilterStrip {...stripProps} className="hidden min-w-0 flex-1 lg:flex" />

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="hidden h-6 w-px bg-divider lg:block" aria-hidden="true" />

          {/* One border, internal dividers: reads as a single control that holds
              several verbs. */}
          <div className="hidden items-center gap-0.5 rounded-full border border-hairline px-1 py-0.5 sm:flex">
            <ToolButton
              onClick={onStar}
              label="Star"
              hint="s"
              disabled={!hasSelection}
            >
              <Star size={16} strokeWidth={1.9} />
            </ToolButton>
            <span className="mx-1 h-4 w-px bg-divider" aria-hidden="true" />
            <ToolButton
              onClick={onRead}
              label="Mark read or unread"
              hint="u"
              disabled={!hasSelection}
            >
              <Mail size={16} strokeWidth={1.9} />
            </ToolButton>
            <ToolButton onClick={onMarkAllRead} label="Mark all read" hint="⇧U">
              <Check size={16} strokeWidth={1.9} />
            </ToolButton>
            <span className="mx-1 h-4 w-px bg-divider" aria-hidden="true" />
            <ToolButton
              onClick={onArchive}
              label={archiveLabel}
              hint="e"
              disabled={!hasSelection}
            >
              {activeMailbox === "inbox" ? (
                <Archive size={16} strokeWidth={1.9} />
              ) : (
                <RotateCcw size={16} strokeWidth={1.9} />
              )}
            </ToolButton>
            <ToolButton
              onClick={onTrash}
              label={trashLabel}
              hint="#"
              disabled={!hasSelection}
            >
              <Trash2 size={16} strokeWidth={1.9} />
            </ToolButton>
          </div>

          <span className="hidden h-6 w-px bg-divider lg:block" aria-hidden="true" />

          <div className="flex items-center gap-0.5">
            <ToolButton
              onClick={onRefresh}
              label={syncing ? "Syncing" : "Sync now"}
              disabled={syncing}
            >
              <RefreshCw
                size={15}
                strokeWidth={1.9}
                className={syncing ? "animate-spin" : ""}
              />
            </ToolButton>
            <ToolButton onClick={onSettings} label="Settings" hint=",">
              <Settings2 size={15} strokeWidth={1.9} />
            </ToolButton>
          </div>

          {/*
            Where you are. The position is the point, so it is the only thing here that
            is not muted.

            Compact below `sm`: the list's own name and the word "of" are dropped, which
            takes this cluster from ~190px to ~90px. That matters because every other
            child of the row is `shrink-0` — together the two made the row 756px wide on
            a 390px phone, so the search box sat off the right edge and only a
            horizontal scroll of a toolbar could reach it.

            Neither dropped element was only information: the active mailbox pill already
            names the list, and `12/38` reads the same as `12 of 38`.
          */}
          <div className="flex items-center gap-0.5 rounded-full border border-hairline py-0.5 pl-2.5 pr-1 sm:pl-3">
            {/* The list's own name, truncated rather than wrapped: a long sender
                address must not push the arrows out of the cluster. */}
            <span
              className="mr-1 hidden max-w-[9rem] truncate text-ui font-semibold text-ink-body sm:inline"
              title={listTitle}
            >
              {listTitle}
            </span>
            <span className="text-ui font-semibold tabular-nums text-ink">{position}</span>
            <span className="text-ui tabular-nums text-ink-subtle">
              <span className="hidden sm:inline">of </span>
              <span className="sm:hidden">/</span>
              {total}
            </span>
            <button
              type="button"
              onClick={onPrev}
              aria-label="Previous message"
              disabled={cursorIndex <= 0}
              className={ICON_BUTTON}
            >
              <ChevronLeft size={17} />
            </button>
            <button
              type="button"
              onClick={onNext}
              aria-label="Next message"
              disabled={total === 0 || cursorIndex >= total - 1}
              className={ICON_BUTTON}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 px-4 pb-2.5 lg:hidden">
        {/*
          The narrow copy of the rail.

          `inert`, not `aria-hidden`. The strip is rendered twice from the same props
          so it can sit inline at `lg` and on its own row below it, and the two copies
          are genuinely the same control list. `aria-hidden` hides the second one from
          a screen reader while leaving every button in it *tabbable* — so a keyboard
          user walked into a set of controls the assistive technology would not announce,
          and pressing Enter there toggled a filter nobody had heard of.

          `inert` removes the copy from both the accessibility tree and the tab order,
          which is what "this is a duplicate, do not use it" actually means. The browser
          support is complete in every engine this app targets, and the copy is only
          rendered below `lg` anyway, where the inline one is `hidden`.
        */}
        <div inert className="min-w-0 flex-1">
          <FilterStrip {...stripProps} />
        </div>
      </div>

      {/*
        The status line: what the app last did, and who it is signed in as.

        Small, because it is a footnote — but it is the only place a user can confirm
        which account they are reading, which on a shared machine matters, and it is
        also where the demo says what it is and offers the way out of it.
      */}
      <div className="flex min-h-[26px] items-center justify-between gap-3 border-t border-hairline-soft px-4 py-1">
        <span className="truncate text-[11.5px] text-ink-subtle">
          {accountEmail
            ? lastSyncedAt
              ? `Synced ${formatRelative(lastSyncedAt, Date.now())}`
              : "Not synced yet"
            : // The demo is a sample, and saying "not synced yet" about it is
              // technically true and completely misleading: there is no account to sync
              // with, and pretending otherwise invites the user to wait for mail that
              // will never arrive.
              "Demo mailbox — nothing leaves this device"}
        </span>

        {accountEmail ? (
          <button
            type="button"
            onClick={onSignOut}
            title="Sign out"
            className="flex shrink-0 items-center gap-1 text-[11.5px] font-semibold text-ink-subtle transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <span className="max-w-[16rem] truncate">{accountEmail}</span>
            <X size={11} strokeWidth={2.2} aria-hidden="true" />
          </button>
        ) : (
          /*
            Connect, from the demo.

            This is the whole route to sign-in on a fresh install. The app renders the
            demo immediately so there is no spinner on launch and no sign-in wall in
            front of the classification — and the cost of that choice is that the sign-in
            *screen* never appears on first run, so the affordance has to live here,
            next to the sentence that says you are looking at a sample.

            The failure is rendered beside the button rather than in the app-wide error
            strip, because this is not the app's error — it is this button's, and it
            belongs next to the thing that failed. It stays until the next attempt.
          */
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            {connectError && (
              <span
                role="alert"
                className="max-w-[24rem] truncate text-[11.5px] font-medium text-danger"
                title={connectError}
              >
                {connectError}
              </span>
            )}
            <button
              type="button"
              onClick={onSignIn}
              disabled={signingIn}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-hairline px-2.5 py-0.5 text-[11.5px] font-semibold text-ink-body transition-colors hover:bg-surface-hover disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <LogIn size={11} strokeWidth={2.2} aria-hidden="true" />
              {signingIn ? "Waiting for Google…" : "Connect Gmail"}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}



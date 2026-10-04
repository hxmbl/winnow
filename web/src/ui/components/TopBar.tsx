/**
 * The top bar.
 *
 * Three rows, in a deliberate order: identity and actions, then the filter rail,
 * then the status line. The rail used to sit inline with everything else on a wide
 * screen and only got its own row on a narrow one, and that is backwards.
 *
 * The rail is the product. It is where Winnow's opinion about your mail is on
 * screen, ranked by how much mail each bucket holds, and it is long — the demo
 * inbox alone puts twenty-eight pills in it. Sharing a row with the mailbox nav,
 * the search box, five action buttons, two icon buttons and the position cluster
 * left it about 450px at 1440, which showed *three* pills and a fade. Everything
 * else on that row is `shrink-0` because it must not reflow; the rail was the only
 * elastic child, so it absorbed the entire shortfall. The three most important
 * controls in the app were the three that fit.
 *
 * Giving it its own full-width row costs about 30px of chrome and buys roughly
 * fifteen visible pills instead of three — and it removes the second copy of the
 * strip entirely. That copy existed only to serve the narrow layout, and was
 * rendered with `inert` so it would not appear twice to assistive technology: two
 * renderings, one scroll container, one `ResizeObserver`, one set of overflow
 * fades, for one control list.
 *
 * The status line is last because it is a footnote — but it is the only place a
 * user can confirm which account they are reading, which on a shared machine
 * matters, and it is also where the demo says what it is and offers the way out.
 *
 * Left-to-right within the first row is "what am I looking at" → "act on it", with
 * the hairline before the action cluster marking exactly that boundary.
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
  Undo2,
  X,
} from "lucide-react";
import { formatRelative } from "../../core/mail/datetime";
import { shortcutFor } from "../../core/mail/keybinds";
import { AppMark } from "../AppMark";
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
  /**
   * Which row the cursor is on, or `null` when it has never moved.
   *
   * `null` rather than `0` because "not on anything yet" and "on the first row" are
   * different states, and rendering the first as `0` in a "3 of 38"-shaped cluster
   * reads as an empty list.
   */
  position: number | null;
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

/**
 * The action cluster. Disabled rather than hidden when there is no selection.
 *
 * The `hint` is resolved through the keybind table rather than typed in, so a button's
 * tooltip can only advertise a shortcut the router actually takes. It used to be a
 * literal per button, which is the drift the cheat sheet's comment describes — `,` and
 * `⇧U` worked for weeks without appearing anywhere, and nothing stopped a fourth
 * button from advertising a key that did nothing.
 */
function ToolButton({
  onClick,
  label,
  hint,
  disabled,
  children,
}: {
  onClick: () => void;
  label: string;
  /** The shortcut, or `null`/omitted when the command has no key. */
  hint?: string | null;
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

  /*
    The one context-sensitive verb, and the icon goes with the label.

    Four cases rather than three, because Spam is not Archive or Restore and calling it
    "Restore" in a spam folder describes an action the user is not being offered. From
    Spam the button moves the message back to the inbox — which is what Gmail calls
    "Not spam", what the reader's own button calls it, and what it is.

    The label and the icon were separate decisions and had drifted: the icon had become
    "not in the inbox, so it points back" while the label still read "Restore". Both now
    come from the same case.
  */
  const archiveLabel =
    activeMailbox === "inbox"
      ? "Archive"
      : activeMailbox === "archive"
        ? "Move to inbox"
        : activeMailbox === "spam"
          ? "Not spam"
          : "Restore";
  // The icon is an element rather than a component reference, so the label and the
  // glyph come from one expression — and so `no-unused-vars`, which does not track
  // JSX usage without the React plugin, can see that it is used at all.
  const archiveIcon =
    activeMailbox === "inbox" ? (
      <Archive size={16} strokeWidth={1.9} />
    ) : activeMailbox === "spam" ? (
      <Undo2 size={16} strokeWidth={1.9} />
    ) : (
      <RotateCcw size={16} strokeWidth={1.9} />
    );
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
      <div className="flex h-auto min-w-0 flex-wrap items-center gap-2 px-3 py-2 sm:h-14 sm:flex-nowrap sm:gap-3 sm:px-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center">
          <AppMark />
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
          `max-w-[240px]` still stops it eating the bar on a desktop.

          Now that the rail has its own row, this box has the rest of the first row to
          itself and can afford to be a little wider — searching is the second thing
          you do in a mail client and it should not be the smallest thing you can see.
          420px rather than 240 because of what a cap *below* the available width
          produces: the actions cluster is `ml-auto`, so the space a narrower box
          leaves does not close up — it opens into ~380px of nothing between the
          search field and the first icon on a 1440px window, which reads as a
          layout mistake rather than as breathing room. A box wide enough to hold a
          sender's name and a subject fragment is the width that earns the space.
        */}
        <label
          htmlFor="topbar-search"
          className="order-last flex h-8 w-full min-w-0 items-center gap-2 rounded-full border border-hairline bg-surface-sunken px-3 sm:order-none sm:max-w-[420px] sm:flex-1 sm:min-w-[9.5rem]"
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

        {/* The inline strip is the live one, and the only one — it moved to its own
            full-width row below, so there is no second copy to keep inert. */}
        <div className="ml-auto flex shrink-0 items-center gap-2 max-sm:ml-0 max-sm:w-full max-sm:justify-between">
          <span className="hidden h-6 w-px bg-divider lg:block" aria-hidden="true" />

          {/* One border, internal dividers: reads as a single control that holds
              several verbs. */}
          <div className="hidden items-center gap-0.5 rounded-full border border-hairline px-1 py-0.5 sm:flex">
            <ToolButton
              onClick={onStar}
              label="Star"
              hint={shortcutFor("toggleStar")}
              disabled={!hasSelection}
            >
              <Star size={16} strokeWidth={1.9} />
            </ToolButton>
            <span className="mx-1 h-4 w-px bg-divider" aria-hidden="true" />
            <ToolButton
              onClick={onRead}
              label="Mark read or unread"
              hint={shortcutFor("toggleRead")}
              disabled={!hasSelection}
            >
              <Mail size={16} strokeWidth={1.9} />
            </ToolButton>
            <ToolButton
              onClick={onMarkAllRead}
              label="Mark all read"
              hint={shortcutFor("markAllRead")}
            >
              <Check size={16} strokeWidth={1.9} />
            </ToolButton>
            <span className="mx-1 h-4 w-px bg-divider" aria-hidden="true" />
            <ToolButton
              onClick={onArchive}
              label={archiveLabel}
              hint={shortcutFor("archive")}
              disabled={!hasSelection}
            >
              {archiveIcon}
            </ToolButton>
            <ToolButton
              onClick={onTrash}
              label={trashLabel}
              hint={shortcutFor("trash")}
              disabled={!hasSelection}
            >
              <Trash2 size={16} strokeWidth={1.9} />
            </ToolButton>
          </div>

          <span className="hidden h-6 w-px bg-divider lg:block" aria-hidden="true" />

          <div className="flex items-center gap-0.5 max-sm:order-last max-sm:ml-auto">
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
            <ToolButton onClick={onSettings} label="Settings" hint={shortcutFor("openSettings")}>
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
            names the list, and `—/38` reads the same as `— of 38`.

            Below `sm` this cluster moves to the *front* of the line it wrapped onto,
            with the sync and settings buttons pushed to the far right. It used to sit
            hard against the right edge with 250px of nothing to its left, which reads as
            a toolbar that failed to lay out rather than as a deliberate arrangement.

            The two `max-sm:order-*` pairs are one swap, not four independent decisions:
            both clusters are `ml-auto`-pushed on a wide screen by the wrapper above,
            and both have to give that up below `sm` or the swap achieves nothing.
          */}
          <div className="flex items-center gap-0.5 rounded-full border border-hairline py-0.5 pl-2.5 pr-1 sm:pl-3 max-sm:order-first">
            {/* The list's own name, truncated rather than wrapped: a long sender
                address must not push the arrows out of the cluster. */}
            <span
              className="mr-1 hidden max-w-[9rem] truncate text-ui font-semibold text-ink-body sm:inline"
              title={listTitle}
            >
              {listTitle}
            </span>
            <span className="text-ui font-semibold tabular-nums text-ink">
              {position ?? "—"}
            </span>
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

      <div className="flex items-center gap-2 px-3 pb-2.5 sm:px-4">
        <FilterStrip {...stripProps} className="min-w-0 flex-1" />
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
            <span className="max-w-[16rem] truncate" title={accountEmail}>
              {accountEmail}
            </span>
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

            Wrapped, not truncated. This is where a build-level problem lands — "this
            build has no Google client id, so it cannot sign in. Set
            VITE_GMAIL_CLIENT_ID" — and clipping the tail of it with an ellipsis
            removed the one half of the sentence the user needs. A `title` attribute
            held the full text, but a hover tooltip on a red line is something nobody
            discovers while their app will not sign in.
          */
          <div className="flex min-w-0 shrink items-start gap-2">
            {connectError && (
              <span
                role="alert"
                className="max-w-[24rem] text-[11.5px] font-medium leading-snug text-danger"
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



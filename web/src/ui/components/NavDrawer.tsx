/**
 * The navigation drawer.
 *
 * What the logo opens. A drawer rather than a sidebar for the reason `NavigationPalette`
 * is an overlay: a permanent folder rail spends ~200px of a full-window reading surface
 * on four destinations the user visits deliberately rather than continuously.
 *
 * **It is a surface of the window, not a component in it.** The panel is flush to the
 * left edge and full height — no inset, no rounding, no margin — because a rounded panel
 * floating 16px from the edge reads as a dialog *pretending* to be a sidebar. The fill is
 * `--wn-veil` behind a `backdrop-filter`, on a `--wn-scrim`, so the list and reader stay
 * legible through it as texture.
 *
 * The motion matches the object: it comes *out of the left edge* with a translation and
 * no scale, because a place arriving is not a card appearing.
 *
 * **It is a `dialog`, not a `menu`,** even though every row is a destination: it is
 * opened with a pointer at a specific place in the chrome, contains the account you are
 * signed in as and a way out, and is dismissible by clicking beside it. The `!` palette
 * is the `menu`.
 */

import { Inbox, LogIn, LogOut, RefreshCw, Send, Settings, Trash2, TriangleAlert, X } from "lucide-react";
import { Sheet } from "./Overlay";
import type { Mailbox } from "../../core/model/email";

export type NavDrawerProps = {
  mailboxes: readonly { id: Mailbox; label: string; unread: number }[];
  activeMailbox: Mailbox;
  onSelectMailbox: (mailbox: Mailbox) => void;
  accountEmail: string | null;
  onSignOut: () => void;
  onSignIn: () => void;
  signingIn: boolean;
  syncing: boolean;
  onRefresh: () => void;
  onSettings: () => void;
  onClose: () => void;
};

export function NavDrawer({
  mailboxes,
  activeMailbox,
  onSelectMailbox,
  accountEmail,
  onSignOut,
  onSignIn,
  signingIn,
  syncing,
  onRefresh,
  onSettings,
  onClose,
}: NavDrawerProps) {
  return (
    <Sheet
      role="dialog"
      label="Navigation"
      placement="left"
      onClose={onClose}
      className="flex w-[17rem] max-w-[82vw] flex-col border-0 bg-veil shadow-lift backdrop-blur-xl"
    >
      <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-4">
        <span className="text-micro font-semibold uppercase tracking-[0.09em] text-ink-subtle">
          Winnow
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="flex h-7 w-7 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <X size={15} strokeWidth={2} />
        </button>
      </div>

      {/*
        Mailboxes.

        A plain list rather than a row of pills: this is a place to go, and a place is a
        row. The active one is `sheen` — the same illumination the rail uses for an active
        filter, because they are the same idea.
      */}
      <nav aria-label="Mailboxes" className="mt-2 flex flex-col gap-0.5 px-2">
        {mailboxes.map((mailbox) => {
          const active = mailbox.id === activeMailbox;
          return (
            <button
              key={mailbox.id}
              type="button"
              onClick={() => {
                onSelectMailbox(mailbox.id);
                onClose();
              }}
              data-unread={mailbox.unread || undefined}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                active
                  ? "bg-sheen font-semibold text-ink"
                  : "text-ink-body hover:bg-surface-hover"
              }`}
            >
              <MailboxIcon id={mailbox.id} />
              <span className="flex-1 truncate">{mailbox.label}</span>
              {mailbox.unread > 0 && (
                <span className="shrink-0 text-[11.5px] font-semibold tabular-nums text-ink-subtle">
                  {mailbox.unread}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-4 px-4">
        <button
          type="button"
          onClick={onSettings}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Settings size={15} strokeWidth={1.9} className="shrink-0 text-ink-muted" aria-hidden="true" />
          Settings
        </button>
      </div>

      {/*
        The account, at the foot of the drawer.

        Pushed to the bottom rather than sitting under the mailboxes because it is not a
        destination — it is *who you are*. A hairline above it rather than a filled box,
        because the alternative was another bordered container.

        Sync lives here too: it is neither an email action nor navigation, and the drawer
        is the one surface that is about the app rather than about a message.
      */}
      <div className="mt-auto px-4 pb-4 pt-6">
        <div className="h-px w-full bg-hairline" />
        {accountEmail ? (
          <>
            <p className="mt-3 truncate text-[12px] text-ink-subtle" title={accountEmail}>
              {accountEmail}
            </p>
            <div className="mt-2 flex items-center gap-1">
              <button
                type="button"
                onClick={onRefresh}
                disabled={syncing}
                className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold text-ink-body transition-colors hover:bg-surface-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <RefreshCw
                  size={12}
                  strokeWidth={2}
                  className={syncing ? "animate-spin" : ""}
                  aria-hidden="true"
                />
                {syncing ? "Syncing" : "Sync now"}
              </button>
              <button
                type="button"
                onClick={onSignOut}
                className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold text-ink-muted transition-colors hover:bg-surface-hover hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <LogOut size={12} strokeWidth={2} aria-hidden="true" />
                Sign out
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={onSignIn}
            disabled={signingIn}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-full bg-sheen px-3 py-1.5 text-[12.5px] font-semibold text-ink transition-opacity hover:opacity-80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <LogIn size={12} strokeWidth={2.2} aria-hidden="true" />
            {signingIn ? "Waiting for Google…" : "Connect Gmail"}
          </button>
        )}
      </div>
    </Sheet>
  );
}

/**
 * The mailboxes.
 *
 * The same glyphs the `!` palette uses, so the two navigation surfaces are visibly the
 * same set of places.
 */
function MailboxIcon({ id }: { id: Mailbox }) {
  const props = { size: 15, strokeWidth: 1.9, className: "shrink-0 text-ink-muted" } as const;
  if (id === "spam") return <TriangleAlert {...props} aria-hidden="true" />;
  if (id === "trash") return <Trash2 {...props} aria-hidden="true" />;
  if (id === "sent") return <Send {...props} aria-hidden="true" />;
  if (id === "archive") {
    return (
      <svg
        viewBox="0 0 24 24"
        width={15}
        height={15}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 text-ink-muted"
        aria-hidden="true"
      >
        <rect x="2" y="4" width="20" height="5" rx="1" />
        <path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9" />
        <path d="M10 13h4" />
      </svg>
    );
  }
  return <Inbox {...props} aria-hidden="true" />;
}

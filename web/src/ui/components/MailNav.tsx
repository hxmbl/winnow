/**
 * Where you can go: the desktop's floating sidebar and the phone's overflow menu.
 *
 * Both draw the same `NavSections`: Inbox with its count, then "Mail" (the other
 * folders). They differ only in where they sit and how big a target is. The smart
 * filters are not here: they are the filter rail above the list on the desktop and the
 * chip row above the dock on a phone (`FilterStrip`).
 *
 * **The sidebar floats.** 8px from the window's left and top edges, 12px radius, and
 * only as tall as what is in it: it does not run to the bottom of the window, and it
 * scrolls inside itself when the window is shorter than its contents. Its fill is the
 * surface at about three-quarters opacity over a progressive backdrop blur, strongest at
 * its root (the left edge) and fading towards the right: three stacked `backdrop-filter`
 * layers (2/6/14px), each masked by a left→right gradient. No shadow; a hairline edge.
 *
 * Every destination is a button in a `nav` list and the one you are on carries
 * `aria-current`.
 */

import { useRef, useState } from "react";
import { LogIn, LogOut, RefreshCw, Settings } from "lucide-react";
import { AppMark } from "../AppMark";
import { Avatar } from "./Avatar";
import { Menu, type MenuAnchor, type MenuEntry } from "./Menu";
import { Sheet } from "./Overlay";
import { anchorFromElement } from "../menuPlacement";
import type { Mailbox } from "../../core/model/email";

export type NavFolder = { id: Mailbox; label: string; unread: number };

export type NavProps = {
  /** Inbox threads, for the Inbox row's count. */
  inboxCount: number;
  /** Unread inbox messages, published as `data-unread` like every folder row. */
  inboxUnread: number;
  mailbox: Mailbox;
  folders: readonly NavFolder[];
  /** Whether any smart filter is on: Inbox is only the current page with none. */
  filtering: boolean;
  /** Inbox, with every filter off. */
  onInbox: () => void;
  onSelectMailbox: (mailbox: Mailbox) => void;
  /** Signed-in address, or null in the demo. */
  accountEmail: string | null;
  signingIn: boolean;
  onConnect: () => void;
  onSignOut: () => void;
  syncing: boolean;
  syncLabel: string;
  onRefresh: () => void;
  settingsOpen: boolean;
  onOpenSettings: () => void;
};

/** The account, as the footer names it. */
function accountLines(email: string | null): { name: string; detail: string } {
  if (!email) return { name: "Demo account", detail: "Not connected" };
  return { name: email.split("@")[0] || email, detail: email };
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "message" : "messages"}`;
}

type SectionsProps = NavProps & {
  /** 44px rows for a thumb, on the phone. */
  touch: boolean;
  /** Called after any destination is chosen, so the phone menu can close. */
  onNavigate?: () => void;
};

function NavSections({
  inboxCount,
  inboxUnread,
  mailbox,
  folders,
  filtering,
  onInbox,
  onSelectMailbox,
  touch,
  onNavigate,
}: SectionsProps) {
  const row = `${touch ? "min-h-11 px-3 py-2" : "px-2.5 py-1.5"} flex w-full items-center gap-2 rounded-ctl text-left text-ui transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring`;
  const idle = "text-ink-body hover:bg-surface-hover";
  const on = "bg-surface-active font-medium text-ink";
  const count = "ml-auto shrink-0 text-meta tabular-nums";

  const inboxCurrent = mailbox === "inbox" && !filtering;

  return (
    <nav aria-label="Mailbox navigation" data-mail-nav="" className="flex flex-col">
      <ul className="flex flex-col">
        <li>
          <button
            type="button"
            data-nav="inbox"
            data-unread={inboxUnread || undefined}
            aria-current={inboxCurrent ? "page" : undefined}
            aria-label={`Inbox, ${countLabel(inboxCount)}`}
            onClick={() => {
              onInbox();
              onNavigate?.();
            }}
            className={`${row} ${inboxCurrent ? on : idle}`}
          >
            <span className="min-w-0 flex-1 truncate">Inbox</span>
            <span className={`${count} ${inboxCurrent ? "text-accent" : "text-ink-subtle"}`}>{inboxCount}</span>
          </button>
        </li>
      </ul>

      {folders.length > 0 && (
        <>
          <h3
            id={touch ? "nav-mail-touch" : "nav-mail"}
            className={`text-meta font-medium text-ink-subtle ${touch ? "px-3 pb-1 pt-4" : "px-2.5 pb-1 pt-4"}`}
          >
            Mail
          </h3>
          <ul aria-labelledby={touch ? "nav-mail-touch" : "nav-mail"} className="flex flex-col">
            {folders.map((folder) => {

              const current = mailbox === folder.id;
              return (
                <li key={folder.id}>
                  <button
                    type="button"
                    data-nav-folder={folder.id}
                    data-unread={folder.unread || undefined}
                    aria-current={current ? "page" : undefined}
                    aria-label={folder.unread > 0 ? `${folder.label}, ${folder.unread} unread` : folder.label}
                    onClick={() => {
                      onSelectMailbox(folder.id);
                      onNavigate?.();
                    }}
                    className={`${row} ${current ? on : idle}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{folder.label}</span>
                    {folder.unread > 0 && (
                      <span className={`${count} ${current ? "text-accent" : "text-ink-subtle"}`}>{folder.unread}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </nav>
  );
}

/** The account's menu: sync and sign out, or connect from the demo. */
function accountMenu(props: NavProps): MenuEntry[] {
  if (!props.accountEmail) {
    return [
      {
        kind: "item",
        id: "connect",
        label: props.signingIn ? "Waiting for Google…" : "Connect Gmail",
        icon: LogIn,
        disabled: props.signingIn,
        onSelect: props.onConnect,
      },
    ];
  }
  return [
    { kind: "item", id: "sync", label: props.syncLabel, icon: RefreshCw, disabled: props.syncing, onSelect: props.onRefresh },
    { kind: "divider", id: "d1" },
    { kind: "item", id: "sign-out", label: "Sign out", icon: LogOut, danger: true, onSelect: props.onSignOut },
  ];
}

function AccountFooter(props: NavProps & { touch: boolean; onNavigate?: () => void }) {
  const { name, detail } = accountLines(props.accountEmail);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div
      data-nav-account=""
      className={`flex shrink-0 items-center gap-2 border-t border-hairline ${props.touch ? "px-2 pb-2 pt-2" : "px-1.5 pb-1.5 pt-2"}`}
    >
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={`Account: ${name}, ${detail}`}
        onClick={(event) => setAnchor(anchorFromElement(event.currentTarget))}
        className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-ctl px-1.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
          props.touch ? "min-h-12 py-1" : "py-1"
        }`}
      >
        <Avatar name={props.accountEmail ? name : "You"} address={props.accountEmail ?? "you@winnow.demo"} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium text-ink">{name}</span>
          <span className="block truncate text-meta text-ink-subtle">{detail}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => {
          props.onOpenSettings();
          props.onNavigate?.();
        }}
        aria-label="Settings"
        aria-current={props.settingsOpen ? "page" : undefined}
        title="Settings (,)"
        className={`flex shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
          props.touch ? "h-11 w-11" : "h-8 w-8"
        }`}
      >
        <Settings size={17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {anchor && (
        <Menu
          items={accountMenu(props)}
          anchor={anchor}
          label="Account"
          testId="account-menu"
          returnFocus={trigger.current}
          onClose={() => setAnchor(null)}
        />
      )}
    </div>
  );
}

/** The desktop sidebar. See the file comment for why it floats and how it blurs. */
export function Sidebar(props: NavProps) {
  return (
    <aside
      data-sidebar=""
      aria-label="Sidebar"
      className="fixed left-2 top-2 z-30 flex max-h-[calc(100dvh-1rem)] w-60 flex-col overflow-hidden rounded-pane border border-hairline"
    >
      {/* The progressive blur, root (left) to tip (right), then the tint over it. */}
      <div aria-hidden="true" className="wn-sidebar-blur wn-sidebar-blur-1" />
      <div aria-hidden="true" className="wn-sidebar-blur wn-sidebar-blur-2" />
      <div aria-hidden="true" className="wn-sidebar-blur wn-sidebar-blur-3" />
      <div aria-hidden="true" className="wn-sidebar-tint" />

      <div className="relative flex min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2.5 px-3 pb-2 pt-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline">
            <AppMark size={22} />
          </span>
          <span className="text-read font-semibold text-ink">Winnow</span>
        </div>
        <div data-sidebar-scroll="" className="thin-scroll min-h-0 overflow-y-auto px-1.5 pb-2">
          <NavSections {...props} touch={false} />
        </div>
        <AccountFooter {...props} touch={false} />
      </div>
    </aside>
  );
}

/**
 * The phone's overflow menu, Linear-style: one sheet from the top-bar menu button with
 * Inbox, the folders, and the account with Settings. No quick filter: with the smart
 * filters back in the dock's chip row there are only a handful of rows left to narrow.
 */
export function OverflowMenu(props: NavProps & { onClose: () => void }) {
  return (
    <Sheet
      label="Menu"
      placement="fill"
      onClose={props.onClose}
      className="mx-2 mt-[max(0.5rem,env(safe-area-inset-top))] flex max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] flex-col overflow-hidden rounded-pane border border-hairline bg-chrome"
    >
      <div data-overflow-menu="" className="flex min-h-0 flex-1 flex-col">
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-2 pt-2">
          <NavSections {...props} touch onNavigate={props.onClose} />
        </div>
        <AccountFooter {...props} touch onNavigate={props.onClose} />
      </div>
    </Sheet>
  );
}

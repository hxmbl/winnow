/**
 * Where you can go: the desktop's floating sidebar and the phone's overflow menu.
 *
 * Both draw the same `NavSections`: Inbox, then "Categories" (every bucket and sender
 * filter the old top rail carried, with its count), then "Mail" (the other folders).
 * They differ only in where they sit and how big a target is.
 *
 * **The sidebar floats.** 8px from the window's left and top edges, 12px radius, and
 * only as tall as what is in it: it does not run to the bottom of the window, and it
 * scrolls inside itself when the window is shorter than its contents. Its fill is the
 * surface at about three-quarters opacity over a progressive backdrop blur, strongest at
 * its root (the left edge) and fading towards the right: three stacked `backdrop-filter`
 * layers (2/6/14px), each masked by a left→right gradient. No shadow; a hairline edge.
 *
 * **Categories toggle filters**, as the rail's tabs did, so `1`–`9` still address the
 * first nine in order and each row says its digit (`aria-keyshortcuts`, the tooltip).
 * Hiding and restoring a bucket moved into an Edit mode: "Edit" beside the heading shows
 * a Hide control on each row and lists the hidden buckets with a Show control.
 *
 * Every destination is a button in a `nav` list and the one you are on carries
 * `aria-current`.
 */

import { useMemo, useRef, useState } from "react";
import { Eye, EyeOff, LogIn, LogOut, RefreshCw, Search, Settings } from "lucide-react";
import { AppMark } from "../AppMark";
import { Avatar } from "./Avatar";
import { Menu, type MenuAnchor, type MenuEntry } from "./Menu";
import { Sheet } from "./Overlay";
import { anchorFromElement } from "../menuPlacement";
import { digitFor, type PillItem } from "../rail";
import { filterKey, type BuiltinSmartFilter, type FilterId } from "../../core/model/signals";
import type { Mailbox } from "../../core/model/email";

export type NavFolder = { id: Mailbox; label: string; unread: number };

export type NavProps = {
  /** Inbox threads, for the Inbox row's count. */
  inboxCount: number;
  /** Unread inbox messages, published as `data-unread` like every folder row. */
  inboxUnread: number;
  mailbox: Mailbox;
  folders: readonly NavFolder[];
  pills: readonly PillItem[];
  activeFilters: readonly FilterId[];
  /** Inbox, with every filter off. */
  onInbox: () => void;
  onSelectMailbox: (mailbox: Mailbox) => void;
  onToggleFilter: (id: FilterId) => void;
  onMute: (id: BuiltinSmartFilter) => void;
  onRestore: (id: BuiltinSmartFilter) => void;
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
  /** Narrow the categories and folders by name (the phone's quick filter). */
  query?: string;
  /** Called after any destination is chosen, so the phone menu can close. */
  onNavigate?: () => void;
};

function NavSections({
  inboxCount,
  inboxUnread,
  mailbox,
  folders,
  pills,
  activeFilters,
  onInbox,
  onSelectMailbox,
  onToggleFilter,
  onMute,
  onRestore,
  touch,
  query = "",
  onNavigate,
}: SectionsProps) {
  const [editing, setEditing] = useState(false);
  const activeKeys = useMemo(() => new Set(activeFilters.map(filterKey)), [activeFilters]);
  const needle = query.trim().toLowerCase();
  const matches = (label: string) => needle === "" || label.toLowerCase().includes(needle);
  const row = `${touch ? "min-h-11 px-3 py-2" : "px-2.5 py-1.5"} flex w-full items-center gap-2 rounded-ctl text-left text-ui transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring`;
  const idle = "text-ink-body hover:bg-surface-hover";
  const on = "bg-surface-active font-medium text-ink";
  const count = "ml-auto shrink-0 text-meta tabular-nums";

  const inboxCurrent = mailbox === "inbox" && activeFilters.length === 0;
  const live = pills.filter((pill) => !pill.muted);
  const hidden = pills.filter((pill) => pill.muted);
  const shownLive = live.filter((pill) => matches(pill.label));
  const shownFolders = folders.filter((folder) => matches(folder.label));

  return (
    <nav aria-label="Mailbox navigation" data-mail-nav="" className="flex flex-col">
      {matches("Inbox") && (
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
      )}

      {(shownLive.length > 0 || editing) && (
        <>
          <div className={`flex items-center justify-between ${touch ? "px-3 pb-1 pt-4" : "px-2.5 pb-1 pt-4"}`}>
            <h3 id={touch ? "nav-categories-touch" : "nav-categories"} className="text-meta font-medium text-ink-subtle">
              Categories
            </h3>
            <button
              type="button"
              data-nav-edit=""
              aria-pressed={editing}
              onClick={() => setEditing((value) => !value)}
              className={`rounded-ctl px-1.5 text-meta font-medium text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                touch ? "min-h-11" : "py-0.5"
              }`}
            >
              {editing ? "Done" : "Edit"}
            </button>
          </div>
          <ul aria-labelledby={touch ? "nav-categories-touch" : "nav-categories"} className="flex flex-col">
            {shownLive.map((pill) => {
              const index = live.indexOf(pill);
              const key = filterKey(pill.id);
              const active = activeKeys.has(key);
              const digit = touch ? null : digitFor(index);
              const hideable = pill.id.kind === "builtin" && pill.id.id !== "unsafe";
              return (
                <li key={key} className="flex items-center gap-0.5">
                  <button
                    type="button"
                    data-nav-category={key}
                    aria-current={active ? "true" : undefined}
                    aria-label={`${pill.label}, ${countLabel(pill.count)}`}
                    aria-keyshortcuts={digit ?? undefined}
                    title={digit ? `${pill.label} (${digit})` : undefined}
                    onClick={() => {
                      onToggleFilter(pill.id);
                      onNavigate?.();
                    }}
                    className={`${row} min-w-0 ${active ? on : idle}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{pill.label}</span>
                    {!editing && (
                      <span className={`${count} ${active ? "text-accent" : "text-ink-subtle"}`}>{pill.count}</span>
                    )}
                  </button>
                  {editing && hideable && pill.id.kind === "builtin" && (
                    <button
                      type="button"
                      data-nav-hide={pill.id.id}
                      onClick={() => pill.id.kind === "builtin" && onMute(pill.id.id)}
                      aria-label={`Hide ${pill.label} from the inbox and tell Winnow it is over-firing`}
                      title={`Hide ${pill.label}`}
                      className={`flex shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                        touch ? "h-11 w-11" : "h-7 w-7"
                      }`}
                    >
                      <EyeOff size={14} strokeWidth={1.9} aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {editing && hidden.length > 0 && (
            <>
              <p className={`text-meta text-ink-subtle ${touch ? "px-3 pb-1 pt-3" : "px-2.5 pb-1 pt-3"}`}>Hidden</p>
              <ul aria-label="Hidden categories" className="flex flex-col">
                {hidden.map((pill) => (
                  <li key={filterKey(pill.id)} className="flex items-center gap-0.5">
                    <span
                      data-nav-hidden={filterKey(pill.id)}
                      className={`${row} min-w-0 cursor-default text-ink-subtle line-through`}
                    >
                      <span className="min-w-0 flex-1 truncate">{pill.label}</span>
                    </span>
                    {pill.id.kind === "builtin" && (
                      <button
                        type="button"
                        data-nav-restore={pill.id.id}
                        onClick={() => pill.id.kind === "builtin" && onRestore(pill.id.id)}
                        aria-label={`Show ${pill.label} in the inbox again`}
                        title={`Show ${pill.label}`}
                        className={`flex shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                          touch ? "h-11 w-11" : "h-7 w-7"
                        }`}
                      >
                        <Eye size={14} strokeWidth={1.9} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {shownFolders.length > 0 && (
        <>
          <h3
            id={touch ? "nav-mail-touch" : "nav-mail"}
            className={`text-meta font-medium text-ink-subtle ${touch ? "px-3 pb-1 pt-4" : "px-2.5 pb-1 pt-4"}`}
          >
            Mail
          </h3>
          <ul aria-labelledby={touch ? "nav-mail-touch" : "nav-mail"} className="flex flex-col">
            {shownFolders.map((folder) => {
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
 * The phone's overflow menu, Linear-style: one sheet from the top-bar menu button with a
 * quick filter, Inbox, the categories, the folders, and the account with Settings.
 */
export function OverflowMenu(props: NavProps & { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  return (
    <Sheet
      label="Menu"
      placement="fill"
      onClose={props.onClose}
      className="mx-2 mt-[max(0.5rem,env(safe-area-inset-top))] flex max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] flex-col overflow-hidden rounded-pane border border-hairline bg-chrome"
    >
      <div data-overflow-menu="" className="flex min-h-0 flex-1 flex-col">
        <label
          htmlFor="winnow-nav-filter"
          className="m-2 flex h-11 shrink-0 items-center gap-2 rounded-ctl border border-edge bg-surface px-3 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--wn-focusRing)]"
        >
          <Search size={16} className="shrink-0 text-ink-placeholder" aria-hidden="true" />
          <input
            ref={field}
            id="winnow-nav-filter"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Go to…"
            aria-label="Filter the menu"
            className="min-w-0 flex-1 bg-transparent text-read text-ink outline-none placeholder:text-ink-placeholder"
          />
        </label>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          <NavSections {...props} touch query={query} onNavigate={props.onClose} />
        </div>
        <AccountFooter {...props} touch onNavigate={props.onClose} />
      </div>
    </Sheet>
  );
}

/**
 * Where you can go: the sidebar, an overlay on every screen size.
 *
 * It draws `NavSections` (Inbox with its count, then the other folders under a hairline) and the
 * account footer. The smart filters are not here: they are the filter rail above the
 * list on the desktop and the chip row above the dock on a phone (`FilterStrip`).
 *
 * **The sidebar floats over the app.** 8px from the window's left and top edges, 12px
 * radius, and only as tall as what is in it; it scrolls inside itself when the window is
 * shorter than its contents. It slides in over the list and the reader instead of
 * taking a column from them, and the rest of the app sits behind a progressive blur
 * while it is open (see `Sidebar` and `sidebarOverlay.ts`). Its own fill is the surface
 * at about three-quarters opacity over a progressive backdrop blur, strongest at its
 * root (the left edge): three stacked `backdrop-filter` layers (2/6/14px), each masked
 * by a left→right gradient. No shadow; a hairline edge.
 *
 * **On a phone it grows out of the dock's pill** instead: the same position and width,
 * opened upward, in the dock's light frost (`.wn-glass`), with icon rows and the current
 * mailbox on a pill (after Linear's Android menu).
 *
 * Every destination is a button in a `nav` list and the one you are on carries
 * `aria-current`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronsUpDown, LogIn, LogOut, RefreshCw, Settings } from "lucide-react";
import { AppMark } from "../AppMark";
import { Avatar } from "./Avatar";
import { Menu, type MenuAnchor, type MenuEntry } from "./Menu";
import { anchorFromElement } from "../menuPlacement";
import { MAILBOX_ICON } from "../menus";
import { panelOrder } from "../phoneDock";
import type { Mailbox } from "../../core/model/email";
import {
  SIDEBAR_IDLE_CLOSE_MS,
  armsIdleClose,
  firstVisible,
  idleCloseAllowed,
  scrimClickCloses,
  scrimMidpoint,
  isEditingElement,
  SCRIM_ORIGIN,
  scrimLayers,
  scrimMask,
} from "../sidebarOverlay";

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
  /** Called after any destination is chosen, so the sidebar can close. */
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
  // On the phone's panel: 48px rows, an icon and a larger label, and the current one on
  // a pill, as in the reference (Linear's Android menu). The desktop's rows are as before.
  const row = touch
    ? "flex min-h-12 items-center gap-3.5 rounded-full px-3.5 py-2 text-left text-read transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    : "px-2.5 py-1.5 flex items-center gap-2 rounded-ctl text-left text-ui transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
  const idle = touch ? "text-ink-body active:bg-sheen" : "text-ink-body hover:bg-surface-hover";
  const on = touch
    ? "bg-[color-mix(in_srgb,var(--wn-ink)_10%,transparent)] font-medium text-ink"
    : "bg-surface-active font-medium text-ink";
  const count = "ml-auto shrink-0 text-meta tabular-nums";
  const icon = (id: Mailbox, current: boolean) => {
    if (!touch) return null;
    const Icon = MAILBOX_ICON[id];
    return <Icon size={20} strokeWidth={current ? 2.1 : 1.8} aria-hidden="true" className="shrink-0" />;
  };

  const inboxCurrent = mailbox === "inbox" && !filtering;

  // On the phone's panel the whole list is upside down, so the thumb that opened it from
  // the dock finds Inbox at the bottom, on the pill's line, and the rarer folders further
  // up: Spam, Trash, Drafts, then Archive and Sent, then Inbox. The desktop sidebar reads top-down as before.
  const reversed = touch;

  const inbox = (
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
            // On the phone the row stops a pill's cell short of the right edge: the dock's
            // Expand chevron sits there, on top of the panel, in the place it opened from.
            className={`${row} ${inboxCurrent ? on : idle} ${touch ? "w-2/3" : "w-full"}`}
          >
            {icon("inbox", inboxCurrent)}
            <span className="min-w-0 flex-1 truncate">Inbox</span>
            <span className={`${count} ${inboxCurrent ? "text-accent" : "text-ink-subtle"}`}>{inboxCount}</span>
          </button>
        </li>
    </ul>
  );

  // No group heading: Inbox on its own, then the other folders, set apart by a hairline
  // and a little space. The folder names say what they are; a "Mail" title over them said
  // nothing a glance does not. Screen readers get the group's name from `aria-label`.
  const mail = folders.length > 0 && (
        <>
          <div aria-hidden="true" data-nav-divider="" className={touch ? "hidden" : "mx-2.5 my-2 border-t border-hairline-soft"} />
          <ul aria-label="Folders" className="flex flex-col">
            {(reversed ? panelOrder(folders) : folders).map((folder) => {

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
                    className={`${row} ${current ? on : idle} w-full`}
                  >
                    {icon(folder.id, current)}
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
  );

  return (
    <nav aria-label="Mailbox navigation" data-mail-nav="" data-reversed={reversed ? "" : undefined} className="flex flex-col">
      {reversed ? (
        <>
          {mail}
          {inbox}
        </>
      ) : (
        <>
          {inbox}
          {mail}
        </>
      )}
    </nav>
  );
}

/** The account's menu: sync and sign out, or connect from the demo. */
function accountMenu(props: NavProps, onNavigate?: () => void): MenuEntry[] {
  const then = (action: () => void) => () => {
    action();
    onNavigate?.();
  };
  if (!props.accountEmail) {
    return [
      {
        kind: "item",
        id: "connect",
        label: props.signingIn ? "Waiting for Google…" : "Connect Gmail",
        icon: LogIn,
        disabled: props.signingIn,
        onSelect: then(props.onConnect),
      },
    ];
  }
  return [
    { kind: "item", id: "sync", label: props.syncLabel, icon: RefreshCw, disabled: props.syncing, onSelect: then(props.onRefresh) },
    { kind: "divider", id: "d1" },
    { kind: "item", id: "sign-out", label: "Sign out", icon: LogOut, danger: true, onSelect: then(props.onSignOut) },
  ];
}

function AccountFooter(props: NavProps & { touch: boolean; onNavigate?: () => void }) {
  const { name, detail } = accountLines(props.accountEmail);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div
      data-nav-account=""
      // On the phone's panel the account row is at the top (the list is reversed, Inbox
      // nearest the dock), so its hairline is underneath it rather than above.
      className={`flex shrink-0 items-center gap-2 border-hairline ${props.touch ? "mx-3 border-b pb-3 pt-3" : "border-t px-1.5 pb-1.5 pt-2"}`}
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
        <Avatar lookup={false} name={props.accountEmail ? name : "You"} address={props.accountEmail ?? "you@winnow.demo"} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium text-ink">{name}</span>
          <span className="block truncate text-meta text-ink-subtle">{detail}</span>
        </span>
        {/* The account switcher's chevron, as in the reference: this row opens a menu. */}
        {props.touch && <ChevronsUpDown size={16} strokeWidth={1.9} aria-hidden="true" className="shrink-0 text-ink-subtle" />}
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
        className={`flex shrink-0 items-center justify-center text-ink-icon transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
          props.touch
            ? "h-12 w-12 rounded-full bg-[color-mix(in_srgb,var(--wn-ink)_8%,transparent)] active:bg-[color-mix(in_srgb,var(--wn-ink)_14%,transparent)]"
            : "h-8 w-8 rounded-ctl hover:bg-surface-hover"
        }`}
      >
        <Settings size={props.touch ? 20 : 17} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {anchor && (
        <Menu
          items={accountMenu(props, props.onNavigate)}
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

export type SidebarProps = NavProps & {
  open: boolean;
  /** Close it: outside click, Escape, a destination chosen, or the idle timer. */
  onClose: () => void;
  /**
   * On a phone: touch-sized rows, and the sidebar is a panel that grows upward out of
   * the dock's pill (anchored at its position, `--wn-dock-*` in `index.css`) instead of
   * sliding in from the left.
   */
  touch: boolean;
};

/** Elements that can hold focus, for the Tab trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The sidebar, as an overlay over the app on every screen.
 *
 * It slides in over the list and the reader rather than taking a column from them, so
 * opening it never reflows anything. While it is open the rest of the app is behind a
 * progressive blur that is strongest at the middle of the sidebar's right edge and
 * fades out evenly in every direction across the window (`scrimLayers`), over a light tint of the mode's scrim colour, and is `inert`.
 *
 * It closes itself when it is not in use: a click or tap outside it, Escape, choosing
 * anything in it, or the mouse being away from it for `SIDEBAR_IDLE_CLOSE_MS` while
 * nothing inside it is being used (`idleCloseAllowed`). Focus moves in on open (to the
 * current destination) and back to whatever opened it on close.
 *
 * Always mounted, so it can animate out as well as in: closed, it is translated off the
 * left edge (on a phone, down behind the dock), `visibility: hidden` once the slide has
 * finished, and `inert`.
 *
 * On a phone it is the dock's pill, grown: the same left edge, width and bottom as the
 * pill, revealed upward by a `clip-path` that starts as the pill's own shape, in the
 * same light frost (`.wn-glass`). It has no app-name header, its list is reversed (the
 * account and Settings gear on top, Inbox at the bottom on the pill's line, beside the
 * Expand chevron that the dock keeps on top of it), and the desktop's progressive blur
 * spreads over the rest of the app from the middle of its right edge, as on the desktop.
 */
export function Sidebar({ open, onClose, touch, ...props }: SidebarProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  /** Whatever had focus when the sidebar opened, so it can be given back. */
  const restoreRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const idleTimer = useRef<number | null>(null);
  const pointerInside = useRef(false);
  /** A press that began inside the panel is still held (drag-select, scrollbar drag). */
  const pressing = useRef(false);
  /** The browser's context menu was opened from inside the panel. */
  const contextMenu = useRef(false);

  /** Whether it is open now, for timers and listeners that outlive a render. */
  const openRef = useRef(open);
  openRef.current = open;

  const clearIdle = useCallback(() => {
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = null;
  }, []);

  const armIdle = useCallback(() => {
    clearIdle();
    idleTimer.current = window.setTimeout(function check() {
      const panel = panelRef.current;
      // A timer armed by a leave the closing panel itself caused (it slides out from
      // under a still pointer) must not close the next opening.
      if (!panel || !openRef.current) {
        idleTimer.current = null;
        return;
      }
      const active = document.activeElement;
      const inside = active !== null && panel.contains(active);
      const selection = document.getSelection();
      const state = {
        pointerInside: pointerInside.current,
        menuOpen: panel.querySelector('[role="menu"]') !== null,
        editing: inside && isEditingElement(active),
        keyboardFocus: inside && active.matches(":focus-visible"),
        pressing: pressing.current,
        contextMenu: contextMenu.current,
        selecting:
          selection !== null &&
          !selection.isCollapsed &&
          selection.anchorNode !== null &&
          panel.contains(selection.anchorNode),
      };
      if (idleCloseAllowed(state)) {
        idleTimer.current = null;
        onClose();
      } else if (!state.pointerInside) {
        // Still away, but something in the sidebar is in use: look again later.
        idleTimer.current = window.setTimeout(check, SIDEBAR_IDLE_CLOSE_MS);
      } else {
        idleTimer.current = null;
      }
    }, SIDEBAR_IDLE_CLOSE_MS);
  }, [clearIdle, onClose]);

  useEffect(() => clearIdle, [clearIdle]);

  // A press that began inside ends wherever the button comes up, which is often outside
  // the panel (and, for a drag-select, outside the window). Listened for on the window
  // only while open, and the context-menu hold lifts on the first movement back over the
  // page, which is the earliest sign the browser's menu has gone.
  useEffect(() => {
    if (!open) {
      pressing.current = false;
      contextMenu.current = false;
      return;
    }
    const release = (event: Event) => {
      if (!pressing.current) return;
      pressing.current = false;
      // Where the button came up decides where the pointer is: during a drag-select the
      // browser sends no pointerleave as the pointer crosses the panel's edge, so the
      // flag can still say "inside" with the pointer at the far side of the window.
      const panel = panelRef.current;
      if (panel && event instanceof PointerEvent && event.pointerType !== "touch") {
        const under = document.elementFromPoint(event.clientX, event.clientY);
        pointerInside.current = under !== null && panel.contains(under);
      }
      if (!pointerInside.current && (!(event instanceof PointerEvent) || armsIdleClose(event.pointerType))) armIdle();
    };
    const moved = (event: PointerEvent) => {
      if (!contextMenu.current) return;
      contextMenu.current = false;
      if (!pointerInside.current && armsIdleClose(event.pointerType)) armIdle();
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    window.addEventListener("pointermove", moved);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
      window.removeEventListener("pointermove", moved);
    };
  }, [open, armIdle]);

  /** The scroller, kept at its bottom on a phone so Inbox is in reach. */
  const scrollRef = useRef<HTMLDivElement>(null);

  // Focus in on open; back out on close.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (open) {
      wasOpen.current = true;
      clearIdle();
      pointerInside.current = false;
      const active = document.activeElement;
      restoreRef.current = active instanceof HTMLElement && !panel.contains(active) ? active : null;
      const target =
        panel.querySelector<HTMLElement>('[data-mail-nav] [aria-current="page"]') ??
        panel.querySelector<HTMLElement>("[data-mail-nav] button") ??
        panel;
      target.focus({ preventScroll: true });
      return;
    }
    clearIdle();
    if (!wasOpen.current) return;
    wasOpen.current = false;
    // Something else took focus on the way out (Settings opening its sheet): leave it.
    const active = document.activeElement;
    if (active && active !== document.body && !panel.contains(active)) return;
    const opener = restoreRef.current;
    restoreRef.current = null;
    // The opener may have gone while the sidebar was open: unmounted by a breakpoint
    // change, or hidden (the medium-width reader's toggle at `lg`). Then whichever
    // toggle is on screen now, never one that is mounted but hidden.
    const back =
      opener?.isConnected && opener.getClientRects().length > 0
        ? opener
        : firstVisible(document.querySelectorAll<HTMLElement>("[data-sidebar-toggle]"));
    back?.focus({ preventScroll: true });
  }, [open, clearIdle]);

  // Crossing the phone breakpoint while open swaps the rows' order (and moves the account
  // row), which remounts the focused button and drops focus on the body: a keyboard user
  // was left outside the open dialog. Put it back on the current destination.
  const crossedTouch = useRef(touch);
  useEffect(() => {
    if (crossedTouch.current === touch) return;
    crossedTouch.current = touch;
    const panel = panelRef.current;
    if (!open || !panel) return;
    const active = document.activeElement;
    if (active && active !== document.body && panel.contains(active)) return;
    const target =
      panel.querySelector<HTMLElement>('[data-mail-nav] [aria-current="page"]') ??
      panel.querySelector<HTMLElement>("[data-mail-nav] button") ??
      panel;
    target.focus({ preventScroll: true });
  }, [open, touch]);

  // The phone's list is reversed: if it ever outgrows the panel, start at the end that
  // holds Inbox, next to the thumb, rather than at Spam. Its own effect, so a breakpoint
  // change while open does not re-run the focus hand-off above.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (open && touch && scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [open, touch]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        // The account menu handles its own Escape and stops it, so this is the sidebar's.
        // Stopped here so the app's window handler does not also clear a filter or close
        // the reader on the same keypress.
        event.stopPropagation();
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.getClientRects().length > 0,
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  // Where the blur spreads from, across: the sidebar's right edge, on a phone the
  // panel's (which is the pill's).
  const edge = touch ? "calc(var(--wn-dock-left) + var(--wn-dock-pill-w))" : "calc(0.5rem + 15rem)";

  // And the height of its middle: the panel is only as tall as its contents, so this is
  // measured rather than worked out, and kept current as the panel grows or the window
  // shrinks it. Written straight onto the scrim, so a resize never re-renders the sidebar.
  const scrimRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = panelRef.current;
    const scrim = scrimRef.current;
    if (!panel || !scrim) return;
    let last: string | null | undefined;
    const measure = () => {
      const rect = panel.getBoundingClientRect();
      const mid = scrimMidpoint(rect);
      // Written only when it changes: a style write invalidates the scrim's masks, and a
      // resize drag fires this every frame with the same answer.
      if (mid === last) return;
      last = mid;
      if (mid === null) scrim.style.removeProperty("--wn-sidebar-mid");
      else scrim.style.setProperty("--wn-sidebar-mid", mid);
    };
    measure();
    // The panel's size is watched; its *position* is not something a ResizeObserver
    // sees, and the top moves with the safe area when a phone turns, without the panel
    // changing size. So the window's resize is watched too, once per frame at most.
    let frame = 0;
    const onResize = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(panel);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [touch]);

  return (
    <>
      <div
        ref={scrimRef}
        aria-hidden="true"
        data-sidebar-scrim=""
        data-open={open ? "" : undefined}
        className="wn-scrim fixed inset-0 z-40"
        style={{ "--wn-sidebar-edge": edge } as React.CSSProperties}
        onClick={open ? (event) => {
          if (scrimClickCloses(event.detail)) onClose();
        } : undefined}
      >
        {scrimLayers().map((layer) => {
          const mask = scrimMask(layer, SCRIM_ORIGIN);
          return (
            <div
              key={layer.blur}
              data-scrim-layer={layer.blur}
              className="wn-scrim-layer"
              style={{
                backdropFilter: `blur(${layer.blur}px)`,
                WebkitBackdropFilter: `blur(${layer.blur}px)`,
                maskImage: mask,
                WebkitMaskImage: mask,
              }}
            />
          );
        })}
        <div className="wn-scrim-tint" />
      </div>

      <div
        ref={panelRef}
        id="winnow-sidebar"
        data-sidebar=""
        data-open={open ? "" : undefined}
        // A dialog only while it is one: closed, it is hidden and inert, and a closed
        // sidebar answering to `[role="dialog"]` would read as an open sheet.
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-label="Menu"
        aria-hidden={open ? undefined : true}
        inert={!open}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onPointerEnter={() => {
          pointerInside.current = true;
          clearIdle();
        }}
        onPointerLeave={(event) => {
          // Whatever left, it is not inside any more: a finger lifting off a hybrid
          // laptop's screen used to leave this set, and the mouse could then never
          // close the sidebar by idling. Only a mouse or a pen arms the timer, though.
          pointerInside.current = false;
          if (!armsIdleClose(event.pointerType)) return;
          if (openRef.current) armIdle();
        }}
        onPointerMove={() => {
          // Any movement over the panel means the pointer is here, whatever the enter and
          // leave events said: a leave that the panel's own slide caused (it moves out from
          // under, or in under, a still pointer) can arrive late and arm a stale timer.
          pointerInside.current = true;
          if (idleTimer.current !== null) clearIdle();
        }}
        onPointerDown={(event) => {
          if (event.button === 0) pressing.current = true;
        }}
        onContextMenu={() => {
          contextMenu.current = true;
          clearIdle();
        }}
        data-morph={touch ? "" : undefined}
        className={`wn-sidebar-panel fixed z-50 flex flex-col overflow-hidden border border-hairline outline-none ${
          touch ? "wn-glass" : "left-2 top-2 max-h-[calc(100dvh-1rem)] w-60 rounded-pane"
        }`}
      >
        {/* The progressive blur, root (left) to tip (right), then the tint over it. */}
        <div aria-hidden="true" className="wn-sidebar-blur wn-sidebar-blur-1" />
        <div aria-hidden="true" className="wn-sidebar-blur wn-sidebar-blur-2" />
        <div aria-hidden="true" className="wn-sidebar-blur wn-sidebar-blur-3" />
        <div aria-hidden="true" className="wn-sidebar-tint" />

        {/*
          One tree for both layouts, so crossing the breakpoint while open keeps the
          scroller (and what has focus in it) mounted. On the phone's panel there is no
          app-name header (the dock and the list already say where you are) and the list
          is reversed: the account and its Settings gear at the top, Inbox at the bottom
          by the tabs. The desktop keeps the header on top and the account at the foot.
        */}
        <div className="wn-morph-content relative flex min-h-0 flex-col">
          {!touch && (
            <div className="flex shrink-0 items-center gap-2.5 px-3 pb-2 pt-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline">
                <AppMark size={22} />
              </span>
              <span className="text-read font-semibold text-ink">Winnow</span>
            </div>
          )}
          {touch && <AccountFooter {...props} touch={touch} onNavigate={onClose} />}
          <div
            ref={scrollRef}
            data-sidebar-scroll=""
            // On the phone the bottom padding puts the Inbox row's middle on the pill's.
            className={`thin-scroll min-h-0 overflow-y-auto overscroll-contain px-1.5 ${touch ? "pb-[5px] pt-2" : "pb-2"}`}
          >
            <NavSections {...props} touch={touch} onNavigate={onClose} />
          </div>
          {!touch && <AccountFooter {...props} touch={touch} onNavigate={onClose} />}
        </div>
      </div>
    </>
  );
}

/**
 * The phone dock's rules that are worth testing without a DOM.
 *
 * The dock is a floating pill of icon-only tabs (Inbox, Sent) and an Expand button,
 * with the compose button as a separate circle beside it. Expand morphs the pill into
 * the menu panel (`Sidebar` in `MailNav.tsx`); the Inbox tab is only ever the inbox; a
 * tap on it while it is already the current tab takes the list back to its top.
 */

import type { Mailbox } from "../core/model/email";
import { MAILBOX_ORDER } from "./mailboxNav";

/**
 * How far the pill's top edge sits above the window's bottom edge, published on
 * `<html>` by the dock. Settings' phone sheet stops there, so the pill stays in reach.
 */
export const PHONE_TABS_VAR = "--wn-phone-tabs";

/**
 * How much of the bottom of the window the floating chrome covers: the chip rail's top
 * edge, measured from the window's bottom, published on `<html>` by the dock. The list
 * pads its end by this much (`index.css`), so its last row scrolls clear of the chips,
 * the pill and the compose button.
 */
export const PHONE_DOCK_VAR = "--wn-phone-dock";

/** The tabs on the pill, in order. Everything else is in the panel behind Expand. */
export const DOCK_TABS = ["inbox", "sent"] as const satisfies readonly Mailbox[];

/** The Expand button's accessible name. Its state is `aria-expanded`. */
export const EXPAND_LABEL = "More mailboxes";

/**
 * What the Expand cell shows (STRM-616, after Linear's mobile tab bar): the switcher
 * slot. While the current mailbox is one of the panel's (Archive, Trash, Spam, Drafts,
 * Snoozed, Scheduled) the cell is the selected one: it widens and shows that mailbox's
 * icon beside a small up/down chevron, on the current tab's fill. On Inbox or Sent it is
 * just the chevron, as before. While the panel is open it is always the plain chevron in
 * its equal third, so it closes the panel from the place it opened and the panel's
 * Settings gear stays centred over it (`MailNav`'s account row is the pill's own grid);
 * while Settings covers the list no mailbox is the current page, so it is plain too.
 */
export type SwitcherSlot = { kind: "chevron" } | { kind: "mailbox"; mailbox: Mailbox };

export function switcherSlot(
  mailbox: Mailbox,
  { menuOpen, settingsOpen }: { menuOpen: boolean; settingsOpen: boolean },
): SwitcherSlot {
  if (menuOpen || settingsOpen) return { kind: "chevron" };
  if ((DOCK_TABS as readonly Mailbox[]).includes(mailbox)) return { kind: "chevron" };
  return { kind: "mailbox", mailbox };
}

/**
 * The Expand button's accessible name for a slot: the plain "More mailboxes", or, with
 * a mailbox in the slot, that mailbox first ("Archive, more mailboxes") so a screen
 * reader hears where you are. Its open/closed state stays `aria-expanded`.
 */
export function expandLabel(slot: SwitcherSlot, label: (mailbox: Mailbox) => string): string {
  return slot.kind === "mailbox" ? `${label(slot.mailbox)}, more mailboxes` : EXPAND_LABEL;
}

/** How much wider than a tab cell the slot grows with a mailbox in it. */
export const SWITCHER_WIDE_FR = 1.5;

/**
 * The pill's three columns, inline on the grid so the change animates: equal thirds
 * (the same as `grid-cols-3`) or the slot widened. The pill itself keeps its width, so
 * the panel that grows out of it (anchored at `--wn-dock-pill-w`) never moves; the two
 * tab cells give up the room.
 */
export function pillColumns(slot: SwitcherSlot): string {
  const last = slot.kind === "mailbox" ? SWITCHER_WIDE_FR : 1;
  return `minmax(0, 1fr) minmax(0, 1fr) minmax(0, ${last}fr)`;
}

/** What a tap on a tab does now. */
export type TabAction = "select" | "clear-filters" | "scroll-top";

/**
 * A tab that is already the current page is the mailbox's "home" gesture: with a smart
 * filter on, the first tap clears it and the list goes back to All (the same as the All
 * chip, Hxmbl, 2026-10-28); with none on, it takes the list back to its top. Any other
 * tab switches to its mailbox, which drops the filters as switching always has. The menu
 * has its own button now, so no tab ever opens it.
 */
export function tabAction(current: boolean, filtering = false): TabAction {
  if (!current) return "select";
  return filtering ? "clear-filters" : "scroll-top";
}

/** What a tab tap can do, for `tapTab`: the dock's own handlers. */
export type TabTapHandlers = {
  onClearFilters: () => void;
  scrollToTop: () => void;
  onSelectMailbox: (mailbox: Mailbox) => void;
  /**
   * Take the smart-filter rail back to its first pill. Every Inbox tap does this as well
   * as its own action (STRM-452), so the rail starts at All again. Optional: other tabs
   * never call it.
   */
  scrollRailToStart?: () => void;
};

/**
 * A tap on the tab for `mailbox`: does what `tabAction` says, through the dock's
 * handlers. Pulled out of `PhoneDock` so the wiring is tested without a DOM. The Inbox
 * tab also takes the smart-filter rail back to its first pill, whatever else it does.
 */
export function tapTab(
  mailbox: Mailbox,
  { current, filtering }: { current: boolean; filtering: boolean },
  handlers: TabTapHandlers,
): TabAction {
  const action = tabAction(current, filtering);
  if (action === "clear-filters") handlers.onClearFilters();
  else if (action === "scroll-top") handlers.scrollToTop();
  else handlers.onSelectMailbox(mailbox);
  if (mailbox === "inbox") handlers.scrollRailToStart?.();
  return action;
}

/** A tab's accessible name: the mailbox, and its unread count when it has one. */
export function tabLabel(label: string, unread: number): string {
  return unread > 0 ? `${label}, ${unread} unread` : label;
}

/** The badge on a tab's icon: nothing at zero, and capped so it stays a badge. */
export function badgeText(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 99 ? "99+" : String(unread);
}

/**
 * The panel's mailboxes above Inbox, top to bottom: the desktop sidebar's order turned
 * upside down, so the phone reads the same list from the thumb up (Hxmbl, 2026-10-21):
 * Spam at the top, Snoozed right above Inbox. Derived from `MAILBOX_ORDER`, so the two
 * can't drift apart. Anything the caller passes that isn't named keeps its place from
 * the reversed order, above the named ones.
 */
export const PANEL_ORDER: readonly Mailbox[] = [...MAILBOX_ORDER].reverse().filter((id) => id !== "inbox");

export function panelOrder<T extends { id: Mailbox }>(folders: readonly T[]): T[] {
  const rank = (id: Mailbox) => (PANEL_ORDER as readonly Mailbox[]).indexOf(id);
  const reversed = [...folders].reverse();
  const other = reversed.filter((folder) => rank(folder.id) < 0);
  const named = reversed.filter((folder) => rank(folder.id) >= 0).sort((a, b) => rank(a.id) - rank(b.id));
  return [...other, ...named];
}

/** The back-to-top pill's accessible name; its visible label is "Top". */
export const BACK_TO_TOP_LABEL = "Back to top";

/** How far down, in screens of the list, before the back-to-top pill appears. */
export const BACK_TO_TOP_SCREENS = 1;

/** What decides whether the back-to-top pill shows. */
export type BackToTopState = {
  /** The list's scroll offset and its own visible height, in px. */
  scrollTop: number;
  viewportHeight: number;
  /** Nothing else has the screen: no multi-selection, overlay, sheet or composer. */
  allowed: boolean;
  /** The dock's panel is expanded (the chips are set aside then too). */
  menuOpen: boolean;
};

/**
 * Whether the back-to-top pill shows: only once the list is more than a screen down,
 * and never over the expanded panel, a selection, Settings or a sheet. A list with no
 * height (hidden behind the reader) has nowhere to go back to.
 */
export function backToTopVisible({ scrollTop, viewportHeight, allowed, menuOpen }: BackToTopState): boolean {
  if (!allowed || menuOpen || viewportHeight <= 0) return false;
  return scrollTop > viewportHeight * BACK_TO_TOP_SCREENS;
}

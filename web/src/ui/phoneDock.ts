/**
 * The phone dock's rules that are worth testing without a DOM.
 *
 * The dock is a floating pill of icon-only tabs (Inbox, Sent) and an Expand button,
 * with the compose button as a separate circle beside it. Expand morphs the pill into
 * the menu panel (`Sidebar` in `MailNav.tsx`); the Inbox tab is only ever the inbox; a
 * tap on it while it is already the current tab takes the list back to its top.
 */

import type { Mailbox } from "../core/model/email";

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

/** What a tap on a tab does now. */
export type TabAction = "select" | "scroll-top";

/**
 * A tab that is already the current page takes the list back to its top (the inbox's
 * "home" gesture); any other tab switches to its mailbox. The menu has its own button
 * now, so no tab ever opens it.
 */
export function tabAction(current: boolean): TabAction {
  return current ? "scroll-top" : "select";
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
 * The panel's mailboxes above Inbox, top to bottom: the rarer folders first, then
 * Archive and Sent, the two most used, right above Inbox and the thumb that opened it.
 * `folders` is the desktop's top-down order; anything not named here keeps its place
 * from the reversed desktop order, above the named ones.
 */
export const PANEL_ORDER = ["spam", "trash", "drafts", "archive", "sent"] as const satisfies readonly Mailbox[];

export function panelOrder<T extends { id: Mailbox }>(folders: readonly T[]): T[] {
  const rank = (id: Mailbox) => (PANEL_ORDER as readonly Mailbox[]).indexOf(id);
  const reversed = [...folders].reverse();
  const other = reversed.filter((folder) => rank(folder.id) < 0);
  const named = reversed.filter((folder) => rank(folder.id) >= 0).sort((a, b) => rank(a.id) - rank(b.id));
  return [...other, ...named];
}

/**
 * The phone dock's rules that are worth testing without a DOM.
 *
 * The Inbox tab is two controls in one: the first tap switches to the inbox, and once
 * the inbox is the current tab the next tap raises the menu (the sidebar, as a bottom
 * sheet) and the one after that closes it. Its accessible name has to say which.
 */

/**
 * How far the dock's tab row reaches up from the window's bottom edge, published on
 * `<html>` by the dock so the menu sheet can sit right on top of the tabs.
 */
export const PHONE_TABS_VAR = "--wn-phone-tabs";

/** What a tap on the Inbox tab does now. */
export type InboxTabAction = "select" | "open-menu" | "close-menu";

export function inboxTabAction(current: boolean, menuOpen: boolean): InboxTabAction {
  if (menuOpen) return "close-menu";
  return current ? "open-menu" : "select";
}

/**
 * The Inbox tab's accessible name. Once it is the current tab a second activation opens
 * the menu, so the name says so; with the menu open, that the same activation closes it.
 */
export function inboxTabLabel(unread: number, current: boolean, menuOpen: boolean): string {
  const base = unread > 0 ? `Inbox, ${unread} unread` : "Inbox";
  switch (inboxTabAction(current, menuOpen)) {
    case "close-menu":
      return `${base}. Activate again to close mailboxes and account`;
    case "open-menu":
      return `${base}. Activate again for mailboxes and account`;
    default:
      return base;
  }
}

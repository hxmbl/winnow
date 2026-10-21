/**
 * The Accounts page (1.5): what it lists, what each account's page offers, and where
 * Back goes, as pure functions so the rules are tests rather than JSX. The words and
 * colours it shares with the switcher are in `accounts.ts`; the page itself is
 * `components/AccountsPage.tsx`.
 */

import type { AccountSummary } from "../core/store/store";
import { MAX_ACCOUNTS } from "../core/session/accounts";
import { ACCOUNTS_FULL, ADD_ACCOUNT_HELP, unreadLabel } from "./accounts";

/** The page's two screens: every account, or one account's controls. */
export type AccountsView = { screen: "list" } | { screen: "detail"; id: string };

export const ACCOUNTS_LIST: AccountsView = { screen: "list" };

/** What the list screen shows, beside the accounts themselves. */
export type AccountsPageModel = {
  /** The demo's two accounts are on screen, not real ones. */
  demo: boolean;
  /** Every account here is taken: Add account waits until one is signed out. */
  full: boolean;
  addLabel: string;
  addDisabled: boolean;
  /** Under Add account: the Testing-mode note, or why a sixth cannot be added. */
  addHelp: string;
  /** Sign out of all is offered once there is more than one real account to sign out of. */
  signOutAll: boolean;
  /** "Open demo inbox" from a signed-in Winnow (the switcher's, since 1.4.0). */
  openDemo: boolean;
};

export function accountsPageModel(
  accounts: readonly AccountSummary[],
  options: { busy: boolean; canOpenDemo: boolean },
): AccountsPageModel {
  const demo = accounts.some((account) => account.demo);
  const real = accounts.filter((account) => !account.demo);
  const full = !demo && real.length >= MAX_ACCOUNTS;
  const connect = demo || real.length === 0;
  return {
    demo,
    full,
    addLabel: options.busy ? "Waiting for Google…" : connect ? "Connect Gmail" : "Add account",
    addDisabled: options.busy || full,
    addHelp: full ? ACCOUNTS_FULL : ADD_ACCOUNT_HELP,
    signOutAll: !demo && real.length > 1,
    openDemo: !demo && real.length > 0 && options.canOpenDemo,
  };
}

/**
 * The line under an account's address, in the list and on its own page: the open one
 * says so, the rest their unread count. The open account's count is the store's, which
 * knows better than the light sync.
 */
export function accountStatusLine(account: AccountSummary, activeUnread: number): string {
  const count = account.active ? activeUnread : account.unread;
  const label = unreadLabel(count);
  const base = account.active ? "Open now" : label ? `${label} unread` : "No unread mail";
  return account.demo ? `${base} · demo` : base;
}

/** What one account's page offers. */
export type AccountDetail = {
  /** Switch to it (not for the one already open). */
  canSwitch: boolean;
  /** Colour, notifications and sign-out are a real account's: the demo's have Connect Gmail instead. */
  canEdit: boolean;
  canSignOut: boolean;
  connectInstead: boolean;
};

export function accountDetail(account: AccountSummary, busy: boolean): AccountDetail {
  return {
    canSwitch: !account.active && !busy,
    canEdit: !account.demo,
    canSignOut: !account.demo && !busy,
    connectInstead: Boolean(account.demo),
  };
}

/**
 * The screen to show for what was asked. An account's page whose account has gone
 * (signed out here, or from another window) falls back to the list rather than showing
 * controls for nothing.
 */
export function resolveView(view: AccountsView, accounts: readonly AccountSummary[]): AccountsView {
  if (view.screen === "detail" && !accounts.some((account) => account.id === view.id)) return ACCOUNTS_LIST;
  return view;
}

/** Back, Escape and Android's Back: an account's page steps back to the list; the list closes the page. */
export function accountsBack(view: AccountsView): AccountsView | "close" {
  return view.screen === "detail" ? ACCOUNTS_LIST : "close";
}

/** The Settings row that opens the page: how many accounts are here. */
export function accountsSummary(accounts: readonly AccountSummary[]): string {
  const real = accounts.filter((account) => !account.demo).length;
  if (real === 0) return "No Gmail account is signed in yet.";
  return real === 1 ? "1 account on this device" : `${real} accounts on this device`;
}

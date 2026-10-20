/**
 * The account switcher's words and colours (1.4.0), as pure functions so the rules are
 * tests rather than JSX: what the switcher lists (the demo's two accounts in the demo),
 * the dot's colour per mode, the unread figure, and the copy.
 */

import type { AccountSummary } from "../core/store/store";
import { ACCOUNT_COLORS, MAX_ACCOUNTS, isAccountColor, type AccountColor } from "../core/session/accounts";
import { DEMO_ACCOUNT } from "../core/data/demo";
import { DEMO_ACCOUNT_IDS, DEMO_SECOND_ACCOUNT } from "../core/data/demoSecond";
import { ACCENTS, type ThemeName } from "./theme";

/** The fifth colour, beside four of the accents: the danger hue's rose (not the Rose accent), per mode. */
const ROSE: Record<ThemeName, string> = { light: "#B8184A", dark: "#FF80A4", oled: "#FF80A4" };

/** An account's dot, in the mode on screen. */
export function accountColorHex(color: string, scheme: ThemeName): string {
  const name: AccountColor = isAccountColor(color) ? color : ACCOUNT_COLORS[0];
  if (name === "rose") return ROSE[scheme];
  return ACCENTS[name][scheme].accent;
}

/** What Settings calls each colour. */
export const ACCOUNT_COLOR_LABEL: Record<AccountColor, string> = {
  space: "Violet",
  plum: "Plum",
  ember: "Ember",
  aurora: "Teal",
  rose: "Rose",
};

/** The demo's two accounts, so the switcher can be tried with nothing signed in. */
export function demoAccounts(active: "work" | "home"): AccountSummary[] {
  return [
    { id: DEMO_ACCOUNT_IDS.work, email: DEMO_ACCOUNT.email, color: "space", notify: true, unread: null, active: active === "work", demo: true },
    { id: DEMO_ACCOUNT_IDS.home, email: DEMO_SECOND_ACCOUNT.email, color: "aurora", notify: true, unread: active === "work" ? 2 : null, active: active === "home", demo: true },
  ];
}

/** "99+" past 99, nothing for none. */
export function unreadLabel(count: number | null): string {
  if (count === null || count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

/** The one-letter mark when an account has no picture. */
export function accountInitial(email: string): string {
  const first = email.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

export function alreadyAddedMessage(email: string): string {
  return `${email} is already added here, so Winnow switched to it.`;
}

export const ACCOUNTS_FULL = `Winnow holds ${MAX_ACCOUNTS} accounts at most. Sign out of one to add another.`;

/**
 * Under Add account. Every account signs in to the same Google Cloud client, and while
 * that client's consent screen is in Testing, Google only lets in the addresses on its
 * test-user list.
 */
export const ADD_ACCOUNT_HELP =
  "Each account signs in with your own Google client. While its consent screen is in Testing, add every address to the client's test users first (Google Cloud → OAuth consent screen → Test users), or Google refuses the sign-in.";

/** The accessible name of the avatar that opens the switcher. */
export function switcherLabel(accounts: readonly AccountSummary[]): string {
  const active = accounts.find((account) => account.active);
  return active ? `Accounts: ${active.email}` : "Accounts";
}

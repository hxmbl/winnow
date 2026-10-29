/**
 * Settings → Google account → Profile picture (STRM-461): what the row says about the
 * open account's own Google picture, and whether it offers the one re-consent.
 *
 * Pure, so it is tested. The picture itself is read by the bridge (`refreshProfile`) and
 * drawn by `Avatar`, which falls back to the monogram whenever there is none.
 */

import type { AccountSummary } from "../core/store/store";

export type OwnProfileRow = {
  /** The status line under the label. */
  hint: string;
  /** `allow`: the grant lacks the basic profile, so the row offers to ask Google once. */
  action: "allow" | null;
};

export const PROFILE_CONSENT_HINT =
  "Signed in before Winnow asked for your basic profile. Allow it once to show your Google picture.";
export const PROFILE_SHOWN_HINT = "From your Google account.";
export const PROFILE_NONE_HINT = "Your initial shows until your Google account has a picture.";

/** The row for the open account, or `null` when there is none (signed out, the demo). */
export function ownProfileRow(account: Pick<AccountSummary, "picture" | "profileConsent"> | null): OwnProfileRow | null {
  if (!account) return null;
  if (account.profileConsent) return { hint: PROFILE_CONSENT_HINT, action: "allow" };
  return { hint: account.picture ? PROFILE_SHOWN_HINT : PROFILE_NONE_HINT, action: null };
}

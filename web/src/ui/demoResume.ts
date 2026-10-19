/**
 * The demo's way back to a real account.
 *
 * The app boots into the demo, and lands there again from "Couldn't reach Gmail" →
 * "Use the demo inbox", while the account's session is still stored on the device. The
 * demo's call to action used to be Connect Gmail in every case, which sent a signed-in
 * user through Google's whole sign-in again. With a stored session it is "Back to your
 * inbox", which adopts that session (the cached mail, the drafts' owner and contacts
 * access come with it) without asking Google for anything but the profile. Connect
 * Gmail stays for a first run with no session.
 *
 * Pure, so the wording and the fallback rules are tested without a DOM.
 */

import { GmailError } from "../core/gmail/dto";

export const BACK_TO_INBOX = "Back to your inbox";
export const CONNECT_GMAIL = "Connect Gmail";
export const SIGN_IN_AGAIN = "Sign in again";

/** What the demo's button says. */
export function demoCtaLabel({
  resumable,
  signingIn,
  resuming,
  expired = false,
}: {
  /** A session is stored on this device. */
  resumable: boolean;
  /** A Google sign-in is under way. */
  signingIn: boolean;
  /** "Back to your inbox" is under way. */
  resuming: boolean;
  /** The stored session turned out to be expired: the button signs in again. */
  expired?: boolean;
}): string {
  if (signingIn) return "Waiting for Google…";
  if (resuming) return "Opening your inbox…";
  if (resumable) return BACK_TO_INBOX;
  return expired ? SIGN_IN_AGAIN : CONNECT_GMAIL;
}

/** The message when the stored session turned out to be expired or revoked. */
export const SESSION_EXPIRED =
  "Your Google session has expired, so Winnow needs you to sign in again to get back to your inbox.";

/** The message when Google could not be reached; the session is kept for another try. */
export const RESUME_UNREACHABLE = "Couldn't reach Google to open your inbox. Check your connection and try again.";

/**
 * What a failed "Back to your inbox" means: `reauth` when only a new sign-in can help
 * (the grant is gone), so `message` says so beside the button, which becomes "Sign in
 * again" and starts the ordinary sign-in. Not started by itself: on the web that is a
 * redirect to Google, and the reason would be gone before anyone read it. Otherwise
 * the session is kept and the button stays.
 */
export function resumeFailure(error: unknown): { reauth: boolean; message: string } {
  if (error instanceof GmailError) {
    if (error.needsReauth || error.status === 401) return { reauth: true, message: SESSION_EXPIRED };
    if (error.kind === "network" || error.kind === "timeout" || error.status === 0 || error.status >= 500) {
      return { reauth: false, message: RESUME_UNREACHABLE };
    }
  }
  if (error instanceof TypeError) return { reauth: false, message: RESUME_UNREACHABLE };
  const text = error instanceof Error ? error.message : "";
  return { reauth: false, message: text || RESUME_UNREACHABLE };
}

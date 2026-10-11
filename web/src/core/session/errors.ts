/**
 * Sign-in failures, in the words the user should read.
 *
 * Every error path in the OAuth flow lands here. The reason this is its own
 * file rather than a switch inside the sign-in screen: the same failures are
 * reachable from three places (the sign-in button, a silent session restore, a
 * failed refresh), and when they were worded separately the restore path said
 * "unknown error" for a revoked grant the user could fix in ten seconds.
 */

import { isTauri } from "../../platform";

/**
 * A redirect whose `state` could not be matched to a sign-in this window started.
 *
 * `detail` explains *which* part was missing — no state at all, or a state with
 * no verifier behind it — and the likeliest cause. It is shown verbatim, because
 * every variant has a different fix and a bare "could not be verified" sends
 * someone retrying the same dead end.
 */
export class GoogleAuthStateMissing extends Error {
  constructor(detail?: string) {
    super(
      detail
        ? `Sign-in could not be verified. ${detail}`
        : "Sign-in could not be verified. Please try again.",
    );
    this.name = "GoogleAuthStateMissing";
  }
}

export type AuthFailure = {
  /** One line, for the message under the button. */
  message: string;
  /** What the user can do about it, when there is something. */
  hint?: string;
  /** Whether retrying as-is could plausibly work. */
  retryable: boolean;
};

/**
 * Turn any thrown value into something renderable.
 *
 * `unknown` rather than `Error`, because the throws come from three places —
 * `GmailError`, a bare `TypeError` from a failed `fetch`, and a string from
 * an `invoke` rejection — and each says something different about what to do.
 */
export function describeFailure(error: unknown): AuthFailure {
  if (error instanceof GoogleAuthStateMissing) {
    return {
      message: error.message,
      hint: "This usually means the sign-in was started in a different window.",
      retryable: true,
    };
  }

  const kind = (error as { kind?: string; message?: string })?.kind;
  const message = error instanceof Error ? error.message : String(error);

  switch (kind) {
    case "declined":
      return {
        message: "Sign-in was declined.",
        hint: "Winnow needs access to your mail to sort it. Nothing was changed.",
        retryable: true,
      };
    case "state_mismatch":
      return {
        message: "Sign-in could not be verified.",
        // The specific why — which state arrived, which origin saw it, what
        // Google said — lives in the failure's own message, and the screen shows
        // it so debugging is not a retry loop. The generic phrasing is only for
        // a failure that said nothing specific.
        hint:
          message === "Sign-in could not be verified. Please try again."
            ? "Start again from this window."
            : message,
        retryable: true,
      };
    case "reauth_required":
      return {
        message: "Your Google session is no longer valid.",
        hint: "Sign in again to continue.",
        retryable: true,
      };
    case "config":
      return {
        message: "This build is not configured to sign in.",
        // Three variables, and which one is missing depends on the host: every
        // build needs a client id, a website needs a registered redirect URI and
        // a secret, and the desktop needs neither of the last two. Naming all
        // three is honest and beats sending someone to the wrong settings page.
        hint: "A desktop build needs VITE_GMAIL_CLIENT_ID; a website also needs VITE_GMAIL_REDIRECT_URI and VITE_GMAIL_CLIENT_SECRET. Set them and rebuild.",
        retryable: false,
      };
    case "invalid_client":
      return {
        message: "Google rejected this build's credentials.",
        // The overwhelmingly common cause is a client id registered for the
        // wrong kind of client: a "Web application" id on the desktop build, or a
        // "Desktop app" id on a website. Google's own error is `invalid_client`
        // and says nothing more, so the hint has to supply the diagnosis.
        hint: isTauri()
          ? "This looks like a web app client id. A desktop build needs one registered as 'Desktop app'."
          : "This looks like a desktop app client id. A website needs one registered as 'Web application', along with VITE_GMAIL_CLIENT_SECRET.",
        retryable: false,
      };
    case "network":
      return {
        message: "Could not reach Google.",
        hint: "Check your connection and try again.",
        retryable: true,
      };
    case "timeout":
      return {
        message: "Sign-in timed out.",
        hint: "Try again — the browser tab may still be open.",
        retryable: true,
      };
    default:
      return { message, retryable: true };
  }
}

/** A shorter form, for a toast rather than a sign-in screen. */
export function shortFailure(error: unknown): string {
  return describeFailure(error).message;
}

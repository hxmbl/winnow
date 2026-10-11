/** Sign-in failures for display. */

import { isTauri } from "../../platform";

/** Redirect state could not be matched to a sign-in in this window. */
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

/** Turn any thrown value into something renderable. */
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
        hint: "A desktop build needs VITE_GMAIL_CLIENT_ID; a website also needs VITE_GMAIL_REDIRECT_URI and VITE_GMAIL_CLIENT_SECRET. Set them and rebuild.",
        retryable: false,
      };
    case "invalid_client":
      return {
        message: "Google rejected this build's credentials.",
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

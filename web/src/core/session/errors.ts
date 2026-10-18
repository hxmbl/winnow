/** Sign-in failures for display. */

import { isTauri } from "../../platform";
import { SignInUnreachable } from "./exchangeRetry";

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
        message: "Google sign-in isn't set up yet.",
        hint: "Add your own Google OAuth client under Settings → Google account. The setup guide walks through it.",
        retryable: false,
      };
    case "invalid_client":
      return {
        message: "Google rejected your OAuth client.",
        hint: isTauri()
          ? "Check the client ID and secret under Settings → Google account. The desktop app needs a client of type 'Desktop app'."
          : "Check the client ID and secret under Settings → Google account. The browser build needs a client of type 'Web application', with its secret.",
        retryable: false,
      };
    case "network":
      // The sign-in got its code but never reached Google to finish it — Android's
      // paused WebView, or a phone that really is offline. `exchangeRetry.ts`.
      if (error instanceof SignInUnreachable) {
        return {
          message: "Couldn't reach Google to finish signing in.",
          hint: "Check your connection and try again.",
          retryable: true,
        };
      }
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

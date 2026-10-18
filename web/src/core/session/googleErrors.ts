/**
 * Google's setup errors, in plain words, each with the fix and the setup step it lives on.
 *
 * Bringing your own OAuth client means meeting Google's errors first-hand, and they are
 * written for developers: "Error 400: redirect_uri_mismatch", "Error 403: access_denied
 * … has not completed the Google verification process", "Gmail API has not been used in
 * project … or it is disabled". Most of them come from one of five mistakes, and each
 * mistake has one place in the setup walkthrough where it is fixed:
 *
 *   | Mistake                         | Google says                                   | Step    |
 *   | ------------------------------- | --------------------------------------------- | ------- |
 *   | Wrong client type               | redirect_uri_mismatch (desktop), unauthorized_client, invalid_request on a loopback | client |
 *   | Redirect URI not registered     | redirect_uri_mismatch                          | client  |
 *   | Gmail API not enabled           | SERVICE_DISABLED / accessNotConfigured, 403     | apis    |
 *   | Not a test user                 | access_denied + "verification process", 403    | consent |
 *   | Wrong or missing secret / id    | invalid_client                                 | paste   |
 *
 * `explainGoogleError` takes whatever is at hand — an error code from a redirect, a
 * token-endpoint answer, a Gmail API error body, or text the user pasted off Google's
 * error page — and returns the matching explanation, or `null` when it does not
 * recognise it. Pure: no DOM, no network.
 */

import { CLIENT_SECRET_PREFIX, type ClientKind } from "./credentials";

/** The walkthrough step a fix lives on. Mirrors `ui/googleSetupSteps`' ids. */
export type SetupStepRef = "project" | "apis" | "consent" | "client" | "paste";

export type GoogleErrorCode =
  | "redirect_uri_mismatch"
  | "wrong_client_type"
  | "api_disabled"
  | "not_test_user"
  | "invalid_client"
  | "secret_missing"
  | "deleted_client"
  | "org_internal"
  | "admin_blocked"
  | "invalid_scope"
  | "scope_not_granted"
  | "access_denied";

export type GoogleErrorHelp = {
  code: GoogleErrorCode;
  /** One line: what went wrong, in plain words. */
  title: string;
  /** What to do about it. */
  fix: string;
  /** The walkthrough step where it is fixed. */
  step: SetupStepRef;
};

/** What we know about the failure. Any field may be missing. */
export type GoogleErrorInput = {
  /** An OAuth error code (`error=` on a redirect, `error` in a token response). */
  error?: string;
  /** Google's `error_description`, a Gmail error message, or text pasted off Google's page. */
  description?: string;
  /** An HTTP status, when the failure came from an API call. */
  status?: number;
};

const has = (text: string, pattern: RegExp) => pattern.test(text);

/** The plain-words fix for a Google error, or `null` when it is not one we know. */
export function explainGoogleError(input: GoogleErrorInput, kind: ClientKind): GoogleErrorHelp | null {
  const error = (input.error ?? "").trim().toLowerCase();
  const text = `${input.error ?? ""} ${input.description ?? ""}`;
  const clientType = kind === "desktop" ? "Desktop app" : "Web application";

  // The Gmail (or People) API is off for the project. Checked first: its 403 also says
  // "access" and "denied" in places, and enabling the API is the whole fix.
  if (
    has(text, /SERVICE_DISABLED|accessNotConfigured|has not been used in project|\bAPI\b[^.]*\b(is|has been) disabled/i)
  ) {
    const people = has(text, /people\.googleapis|People API/i);
    return {
      code: "api_disabled",
      title: people ? "The People API is turned off for your project." : "The Gmail API is turned off for your project.",
      fix: people
        ? "Open the People API page in your project and choose Enable, then try again. It's only needed for contact suggestions and photos."
        : "Open the Gmail API page in the same project as your client and choose Enable. Google can take a minute or two to notice, then sign in again.",
      step: "apis",
    };
  }

  if (error === "redirect_uri_mismatch" || has(text, /redirect_uri_mismatch|redirect URI.*(doesn't|does not) match/i)) {
    return kind === "desktop"
      ? {
          code: "wrong_client_type",
          title: "Your client isn't a Desktop app client.",
          fix: "The desktop and Android apps sign in through a local address that only a Desktop app client accepts. Create a new client with Application type Desktop app, and paste that one in.",
          step: "client",
        }
      : {
          code: "redirect_uri_mismatch",
          title: "Google doesn't have this page's address on your client.",
          fix: "Add the redirect URI shown in step 4 to your Web application client's Authorised redirect URIs, exactly as shown (trailing slash included). If the client is a Desktop app client, create a Web application one instead.",
          step: "client",
        };
  }

  if (
    has(text, /has not completed the Google verification process|not.*test user|only.*test users|access to this app.*limited|app is currently being tested/i)
  ) {
    return {
      code: "not_test_user",
      title: "Your Gmail address isn't a test user yet.",
      fix: "While the app is in Testing, Google only lets in the addresses on its test user list. Add the Gmail address you sign in with under Audience → Test users, then try again.",
      step: "consent",
    };
  }

  if (error === "org_internal" || has(text, /org_internal|restricted to users within its organi[sz]ation/i)) {
    return {
      code: "org_internal",
      title: "Your consent screen only allows your organisation.",
      fix: "Set the audience to External (and leave it in Testing), or sign in with an account from the organisation that owns the project.",
      step: "consent",
    };
  }

  if (error === "admin_policy_enforced" || has(text, /admin_policy_enforced|administrator.*(blocked|restricted)|blocked by your (administrator|admin)/i)) {
    return {
      code: "admin_blocked",
      title: "Your Google Workspace admin blocks unlisted apps.",
      fix: "Ask your admin to trust your client ID under API controls, or use a personal Gmail account.",
      step: "consent",
    };
  }

  if (error === "deleted_client" || error === "disabled_client" || has(text, /deleted_client|disabled_client|client.*(was|has been) (deleted|disabled)/i)) {
    return {
      code: "deleted_client",
      title: "That client was deleted or disabled in Google Cloud.",
      fix: "Create a new OAuth client in your project and paste the new ID (and secret) in.",
      step: "client",
    };
  }

  if (error === "unauthorized_client" || has(text, /unauthorized_client|not allowed for this (client|message) type|invalid parameter value for redirect_uri/i)) {
    return {
      code: "wrong_client_type",
      title: `Your client isn't a ${clientType} client.`,
      fix:
        kind === "desktop"
          ? "Create a new client with Application type Desktop app, and paste that one in."
          : "Create a new client with Application type Web application, add the redirect URI from step 4, and paste that one in with its secret.",
      step: "client",
    };
  }

  if (has(text, /client_secret is missing|missing.*client_secret/i) || (error === "invalid_request" && has(text, /secret/i))) {
    return {
      code: "secret_missing",
      title: "This client needs its client secret.",
      fix: `Copy the client secret from the client's page in Google Cloud (it starts with ${CLIENT_SECRET_PREFIX}) and paste it in.`,
      step: "paste",
    };
  }

  if (error === "invalid_client" || has(text, /invalid_client|OAuth client was not found|client.*not found/i)) {
    const notFound = has(text, /not found/i);
    return {
      code: "invalid_client",
      title: notFound ? "Google doesn't know this client ID." : "Google rejected the client secret.",
      fix: notFound
        ? "Copy the client ID again, in full, from the Clients page of the project you set up."
        : "Copy the secret again from the client's page, or add a new secret there and paste that.",
      step: "paste",
    };
  }

  if (error === "invalid_scope" || has(text, /invalid_scope/i)) {
    return {
      code: "invalid_scope",
      title: "Google refused a scope Winnow asked for.",
      fix: "Add the scopes listed in step 3 under Data access, and make sure the Gmail API is enabled in the same project.",
      step: "consent",
    };
  }

  if (has(text, /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficient authentication scopes/i)) {
    return {
      code: "scope_not_granted",
      title: "Mail access wasn't granted.",
      fix: "Sign in again, and on Google's screen tick the box that lets Winnow read, compose and send your mail.",
      step: "paste",
    };
  }

  if (error === "access_denied" || has(text, /\baccess_denied\b/i)) {
    return {
      code: "access_denied",
      title: "Google didn't let the sign-in through.",
      fix: "If you chose Cancel, nothing is wrong: try again when ready. Otherwise make sure your Gmail address is a test user on the consent screen.",
      step: "consent",
    };
  }

  if (input.status === 403 && has(text, /gmail/i)) {
    return {
      code: "api_disabled",
      title: "The Gmail API is turned off for your project.",
      fix: "Open the Gmail API page in the same project as your client and choose Enable, then sign in again.",
      step: "apis",
    };
  }

  return null;
}

/**
 * Pull an OAuth error out of a block of text — what a user copies off Google's error
 * page ("Error 400: redirect_uri_mismatch …") or an error message Winnow showed.
 */
export function explainGoogleText(text: string, kind: ClientKind): GoogleErrorHelp | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const code = /Error\s+\d{3}:\s*([a-z_]+)/i.exec(trimmed)?.[1] ?? /\b(redirect_uri_mismatch|invalid_client|unauthorized_client|access_denied|org_internal|admin_policy_enforced|invalid_scope|deleted_client|disabled_client|invalid_request)\b/i.exec(trimmed)?.[1];
  return explainGoogleError({ error: code, description: trimmed }, kind);
}

/** Every mistake the walkthrough has a fix for, for its "Google showed an error?" list. */
export const COMMON_GOOGLE_ERRORS: readonly { label: string; sample: string }[] = [
  { label: "Error 400: redirect_uri_mismatch", sample: "Error 400: redirect_uri_mismatch" },
  { label: "Error 403: access_denied (not completed verification)", sample: "Error 403: access_denied The app has not completed the Google verification process" },
  { label: "Error 401: invalid_client", sample: "Error 401: invalid_client The OAuth client was not found." },
  { label: "Gmail API has not been used in project … or it is disabled", sample: "Gmail API has not been used in project 123 before or it is disabled. SERVICE_DISABLED" },
  { label: "Error 400: invalid_request (client_secret is missing)", sample: "Error 400: invalid_request client_secret is missing." },
  { label: "Error 403: org_internal", sample: "Error 403: org_internal" },
];

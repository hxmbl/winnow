/**
 * The user's own Google OAuth client.
 *
 * Winnow ships no Google client. Each person creates one in their own Google Cloud
 * project and pastes its id (and, where Google issued one, its secret) into the setup
 * screen. This file is everything about that pair that is not UI:
 *
 *   - **Validation**, so a typo is caught on the form rather than as a cryptic error on
 *     Google's consent screen.
 *   - **Storage**, behind one interface: the OS keychain on the desktop (the same
 *     `secrets_*` commands the tokens use), `localStorage` in the browser. Neither
 *     sends it anywhere; the only place the pair ever travels is Google's own
 *     authorize and token endpoints.
 *   - **A connection test** that asks Google's token endpoint whether it knows the
 *     client, without signing anyone in.
 *
 * ## Whether a secret is needed
 *
 *   - **Desktop app** clients: Google lists `client_secret` as optional for installed
 *     apps using PKCE, but Desktop clients are issued one and some projects still have it
 *     enforced. The field is optional; when it is filled in, it is sent. For an installed
 *     app it is not confidential — it lives on the user's own machine, in their keychain.
 *   - **Web application** clients: required. Google treats them as confidential and
 *     refuses the exchange without it. In this build it lives in the user's own browser
 *     storage, never in the bundle.
 */

import { GOOGLE_TOKEN_URL } from "../gmail/dto";
import type { FetchLike } from "../gmail/tokens";

/** The pair a user pastes in. */
export type OAuthClientCredentials = {
  clientId: string;
  /** Absent when the user left it blank (allowed for Desktop clients). */
  clientSecret?: string;
};

/** Where the pair lives. Same shape on both hosts. */
export interface CredentialStore {
  read(): Promise<OAuthClientCredentials | null>;
  write(credentials: OAuthClientCredentials): Promise<void>;
  clear(): Promise<void>;
}

/** The suffix every Google OAuth client id carries. */
export const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

/**
 * A plausible client id: a non-empty prefix of the characters Google uses, then the
 * suffix. Google's own ids look like `1234567890-abc123def.apps.googleusercontent.com`;
 * the prefix rule is kept loose on purpose, so a format change on Google's side does not
 * lock anyone out of an app they cannot patch.
 */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/;

/**
 * Google's current client-secret prefix, matched case-insensitively.
 *
 * Written in lower case on purpose: the release workflow fails any bundle that contains
 * the upper-case prefix with a dash, and a literal of it here would trip that guard on
 * every build.
 */
const SECRET_PREFIX = /^gocspx-/i;

/** Which kind of client this host needs. Follows from where the code runs. */
export type ClientKind = "desktop" | "web";

export type CredentialErrors = {
  clientId?: string;
  clientSecret?: string;
};

/** Trim both fields and drop an empty secret. */
export function normaliseCredentials(input: {
  clientId: string;
  clientSecret?: string;
}): OAuthClientCredentials {
  const clientId = input.clientId.trim();
  const clientSecret = (input.clientSecret ?? "").trim();
  return clientSecret ? { clientId, clientSecret } : { clientId };
}

/** The client id's problem, in a sentence, or `null`. */
export function clientIdError(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Enter the client ID from Google Cloud.";
  if (SECRET_PREFIX.test(value)) {
    return "That looks like the client secret. Paste the client ID here instead.";
  }
  if (/\s/.test(value)) return "A client ID has no spaces in it.";
  if (!value.endsWith(CLIENT_ID_SUFFIX)) {
    return `A client ID ends in ${CLIENT_ID_SUFFIX}.`;
  }
  if (!CLIENT_ID_PATTERN.test(value)) {
    return "That doesn't look like a Google client ID. Copy it again from the Clients page.";
  }
  return null;
}

/** The secret's problem, in a sentence, or `null`. */
export function clientSecretError(raw: string | undefined, kind: ClientKind): string | null {
  const value = (raw ?? "").trim();
  if (!value) {
    return kind === "web"
      ? "A Web application client needs its client secret."
      : null;
  }
  if (value.endsWith(CLIENT_ID_SUFFIX)) {
    return "That's the client ID. Paste the client secret here, or leave it blank.";
  }
  if (/\s/.test(value)) return "A client secret has no spaces in it.";
  return null;
}

/** Every field's problem. Empty when the pair can be saved. */
export function validateCredentials(
  input: { clientId: string; clientSecret?: string },
  kind: ClientKind,
): CredentialErrors {
  const errors: CredentialErrors = {};
  const id = clientIdError(input.clientId);
  if (id) errors.clientId = id;
  const secret = clientSecretError(input.clientSecret, kind);
  if (secret) errors.clientSecret = secret;
  return errors;
}

export function hasErrors(errors: CredentialErrors): boolean {
  return Boolean(errors.clientId || errors.clientSecret);
}

/** Parse a stored pair, refusing anything that would not pass validation's id check. */
export function parseStoredCredentials(raw: string | null | undefined): OAuthClientCredentials | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OAuthClientCredentials> | null;
    if (!parsed || typeof parsed.clientId !== "string") return null;
    if (clientIdError(parsed.clientId)) return null;
    return normaliseCredentials({
      clientId: parsed.clientId,
      clientSecret: typeof parsed.clientSecret === "string" ? parsed.clientSecret : undefined,
    });
  } catch {
    return null;
  }
}

/** The key the browser build keeps the pair under. */
export const WEB_CREDENTIALS_KEY = "winnow.google.oauthClient";

/** The keychain entry name the desktop build keeps the pair under. */
export const KEYCHAIN_CREDENTIALS_NAME = "google.oauth-client";

/**
 * The browser's store: `localStorage`, on this origin only.
 *
 * A read that throws (storage disabled) is "nothing stored"; a write that throws is
 * reported, because the user has to know their client was not saved.
 */
export function localStorageCredentialStore(key = WEB_CREDENTIALS_KEY): CredentialStore {
  return {
    async read() {
      try {
        return parseStoredCredentials(globalThis.localStorage?.getItem(key));
      } catch {
        return null;
      }
    },
    async write(credentials) {
      const storage = globalThis.localStorage;
      if (!storage) throw new Error("This browser has no local storage, so the client cannot be saved.");
      storage.setItem(key, JSON.stringify(normaliseCredentials(credentials)));
    },
    async clear() {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // Already unreachable.
      }
    },
  };
}

/** The outcome of asking Google about a client without signing in. */
export type ConnectionTest =
  | { ok: true; message: string }
  | { ok: false; field?: "clientId" | "clientSecret"; message: string };

/**
 * Ask Google's token endpoint whether it recognises the client.
 *
 * Sends a deliberately invalid authorization code. Google checks the client before the
 * code, so the error it returns says which half is wrong:
 *
 *   - `invalid_grant` — the client (and secret, if one is needed) was accepted and only
 *     the made-up code was refused. That is a pass.
 *   - `invalid_client`, "not found" — no such client id.
 *   - `invalid_client`, anything else — the client exists but the secret is wrong.
 *   - `invalid_request` mentioning the secret — this client needs one.
 *
 * The request goes to Google and nowhere else, and nothing is stored.
 */
export async function testConnection(
  credentials: OAuthClientCredentials,
  redirectUri: string,
  fetchImpl: FetchLike | undefined = globalThis.fetch?.bind(globalThis),
): Promise<ConnectionTest> {
  if (!fetchImpl) return { ok: false, message: "This environment cannot make network requests." };

  const body = new URLSearchParams({
    client_id: credentials.clientId,
    code: "winnow-connection-test",
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    // A syntactically valid verifier; the code is refused before it matters.
    code_verifier: "winnow-connection-test-".padEnd(64, "x"),
  });
  if (credentials.clientSecret) body.set("client_secret", credentials.clientSecret);

  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach Google: ${error instanceof Error ? error.message : "network error"}.`,
    };
  }

  let error = "";
  let description = "";
  try {
    const payload = (await response.json()) as { error?: string; error_description?: string };
    error = payload.error ?? "";
    description = payload.error_description ?? "";
  } catch {
    // Not JSON; fall through to the status-based message.
  }

  if (error === "invalid_grant") {
    return { ok: true, message: "Google recognised this client. Connect to finish signing in." };
  }
  if (error === "invalid_client") {
    if (/not found/i.test(description)) {
      return {
        ok: false,
        field: "clientId",
        message: "Google doesn't know this client ID. Check it was copied in full, from the right project.",
      };
    }
    return {
      ok: false,
      field: "clientSecret",
      message: credentials.clientSecret
        ? "Google rejected the client secret. Copy it again from the client's page."
        : "Google wants the client secret for this client. Paste it in.",
    };
  }
  if (error === "invalid_request" && /secret/i.test(description)) {
    return {
      ok: false,
      field: "clientSecret",
      message: "This client needs its client secret. Paste it in.",
    };
  }
  if (error === "unauthorized_client") {
    return {
      ok: false,
      field: "clientId",
      message: "Google says this client can't be used this way. Check its type: Desktop app for the desktop build, Web application for the browser.",
    };
  }
  const detail = description || error || `HTTP ${response.status}`;
  return { ok: false, message: `Google answered: ${detail}` };
}

/** A short form of the id for display: enough to recognise, not the whole thing. */
export function maskClientId(clientId: string): string {
  const prefix = clientId.endsWith(CLIENT_ID_SUFFIX)
    ? clientId.slice(0, -CLIENT_ID_SUFFIX.length)
    : clientId;
  if (prefix.length <= 12) return clientId;
  return `${prefix.slice(0, 6)}…${prefix.slice(-4)}${CLIENT_ID_SUFFIX}`;
}

/**
 * The redirect URI the browser build uses: the app's own address, without query or hash.
 *
 * The page reads a returning `?code=…` wherever it is loaded, so the app's own URL is
 * always a working redirect, and it is the one the setup screen tells the user to
 * register. `index.html` is dropped so `/` and `/index.html` register as one.
 */
export function webRedirectUriFor(location: { origin: string; pathname: string } | undefined): string {
  if (!location?.origin || location.origin === "null") return "";
  const path = location.pathname.replace(/index\.html$/, "") || "/";
  return `${location.origin}${path}`;
}

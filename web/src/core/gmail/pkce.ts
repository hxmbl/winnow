/**
 * PKCE: proving the token exchange is with the app that started it.
 *
 * A desktop app cannot keep a client secret, so RFC 7636's proof-key exchange
 * is what stops an intercepted authorization code from being useful. The shape:
 *
 *   1. Generate a random **verifier** (32 bytes → base64url, 43 characters).
 *   2. Send only its SHA-256 hash, base64url'd, as the **challenge**.
 *   3. Exchange the code with the *verifier*.
 *
 * Only the challenge leaves the machine until step 3, so an attacker who
 * captures the redirect sees a hash they cannot reverse into a verifier.
 *
 * The `state` parameter is a separate defence, against CSRF: it is echoed in
 * the redirect and compared, so a redirect planted by an attacker (carrying
 * *their* code) is rejected before any token is exchanged.
 *
 * This module is environment-agnostic. Where the redirect is *delivered* is the
 * one genuinely native part of sign-in, and that lives in `platform/oauth.ts`.
 */

import { base64UrlEncode } from "./dto";

// Not re-exported: `base64UrlEncode` lives in `dto` because it is the Gmail wire
// alphabet rather than anything to do with PKCE, and `pkce.ts` is one of its four
// callers. An alias here would be a second name for one function, reachable only
// by importing the crypto module and getting the wrong layer's idea of it.

/** Random bytes from the platform CSPRNG. Throws rather than degrading. */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) {
    throw new Error("no secure random source available");
  }
  crypto.getRandomValues(bytes);
  return bytes;
}

/** SHA-256 via WebCrypto. Available in every browser and in the Tauri webview. */
export async function sha256(input: string): Promise<Uint8Array> {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new Error("no WebCrypto available");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

export type PkcePair = {
  /** Kept in memory only, and sent once, to the token endpoint. */
  verifier: string;
  /** The only half that travels in the authorize URL. */
  challenge: string;
  /** Per-attempt CSRF token, compared on the way back. */
  state: string;
};

/**
 * Create a verifier/challenge/state triple.
 *
 * 32 bytes is comfortably above the RFC's 43-character minimum, and the state
 * is a separate 16 bytes so the two can never be confused for one another in a
 * log or a stack trace.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = base64UrlEncode(randomBytes(32));
  const digest = await sha256(verifier);
  return {
    verifier,
    challenge: base64UrlEncode(digest),
    state: base64UrlEncode(randomBytes(16)),
  };
}

export type AuthorizeParams = {
  clientId: string;
  scope: string;
  redirectUri: string;
  challenge: string;
  state: string;
};

/**
 * The Google authorize URL.
 *
 * `access_type=offline` and `prompt=consent` are both deliberate. Without
 * `offline` Google issues no refresh token at all, so the app would need
 * re-authenticating every hour. Without `consent` a second sign-in returns no
 * refresh token either — Google treats an existing grant as sufficient — which
 * is the single most common cause of "it worked once and then stopped".
 */
export function buildAuthorizeUrl(
  endpoint: string,
  params: AuthorizeParams,
  extra: Record<string, string> = {},
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scope,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    state: params.state,
    access_type: "offline",
    prompt: "consent",
    ...extra,
  });
  return `${endpoint}?${query}`;
}

/** What the redirect carried back. */
export type RedirectResult =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; error: string; description: string; state: string }
  | { kind: "none" };

/**
 * Read a redirect — a URL or a query string — into a result.
 *
 * Returns `none` for anything that is not a completed sign-in, so a caller
 * showing this URL in a browser tab does not mistake an ordinary page load for
 * a successful authorisation.
 *
 * ⚠ The desktop build does not parse the redirect in TypeScript at all: Rust binds
 * the loopback socket, reads the request target and returns an `AuthOutcome`. This
 * function exists for a host that only has a URL, and the web build uses
 * `session/redirect.ts`'s own parser instead — which is the one that decides a
 * code without a state is not a redirect. Keep it that way: two parsers, one of
 * which half-accepts a stateless code, is a trap.
 */
export function parseRedirect(input: string): RedirectResult {
  let params: URLSearchParams;
  try {
    // Accept both a full URL and a bare `?a=b`, since the desktop listener
    // sees the request target while a browser tab sees the whole URL.
    const url = input.startsWith("?") || !input.includes("://")
      ? new URL(`http://127.0.0.1/${input}`)
      : new URL(input);
    params = url.searchParams;
  } catch {
    return { kind: "none" };
  }

  const state = params.get("state") ?? "";
  const error = params.get("error");
  if (error) {
    return {
      kind: "error",
      error,
      description: params.get("error_description") ?? error,
      state,
    };
  }

  const code = params.get("code");
  if (!code) return { kind: "none" };

  return { kind: "code", code, state };
}

/** True when the redirect's `state` matches the one we issued. */
export function stateMatches(issued: string, received: string): boolean {
  // Both are non-empty: an empty received state is a redirect we did not make,
  // and accepting it would defeat the check entirely.
  if (!issued || !received) return false;
  // Constant-time is overkill for a random 16-byte value, but the comparison
  // is short enough that it costs nothing and removes the question.
  if (issued.length !== received.length) return false;
  let diff = 0;
  for (let i = 0; i < issued.length; i += 1) diff |= issued.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}

/** A readable message for Google's error codes. */
export function describeAuthError(error: string): string {
  switch (error) {
    case "access_denied":
      return "You declined the request. Winnow needs mail access to sort your inbox.";
    case "invalid_scope":
      return "This Winnow build asked for a permission Google will not grant. Try signing in again.";
    case "unauthorized_client":
      return "This Google account is not allowed to sign in to Winnow.";
    case "server_error":
    case "temporarily_unavailable":
      return "Google is having trouble. Try again in a minute.";
    case "invalid_request":
      return "The sign-in request was malformed. This is a bug in Winnow.";
    default:
      return `Google could not complete sign-in: ${error.replace(/[_-]/g, " ")}.`;
  }
}

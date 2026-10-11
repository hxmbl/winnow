/**
 * PKCE: proving the token exchange is with the app that started it.
 *
 * Desktop app cannot keep a client secret; RFC 7636 stops an intercepted code
 * being useful. Shape: generate random verifier (32 bytes → base64url); send
 * only its SHA-256 hash as challenge; exchange code with verifier. Only
 * challenge leaves until exchange.
 *
 * `state` is a separate CSRF defence (echoed in redirect and compared) so a
 * redirect carrying an attacker's code is rejected before token exchange.
 * Redirect delivery is native and lives in `platform/oauth.ts`.
 */

import { base64UrlEncode } from "./dto";

// `base64UrlEncode` lives in `dto` (Gmail wire alphabet); `pkce.ts` is one of
// its callers. No re-export to avoid confusing layers.

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
 * 32 bytes for verifier (above RFC's 43-char minimum). State is 16 bytes
 * separate to avoid confusion in logs/stack traces.
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
 * `access_type=offline` and `prompt=consent` ensure Google issues a refresh
 * token (without `consent` a second sign-in may return none).
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
 * Returns `none` for anything that is not a completed sign-in. The desktop build
 * parses redirects in Rust (not here); the web build uses its own parser in
 * `session/redirect.ts`.
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
  // Both must be non-empty to avoid accepting an unmade redirect.
  if (!issued || !received) return false;
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

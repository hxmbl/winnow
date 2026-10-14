/**
 * Tokens: storage, refresh, and the races around them.
 *
 * Tokens expire hourly and many things need them at once (sync paging 200
 * messages, scrolling, sending). Failures designed out:
 *
 * 1. Burst of 401s → single-flight (one refresh, not many).
 * 2. Refresh completing after sign-out → generation counter; results from an old
 *    generation are discarded.
 * 3. `invalid_grant` is not retryable (refresh token revoked) → clear and
 *    re-auth.
 *
 * Stored lifetime is floored at `max(expires_in, 65)`; without this, a tiny
 * `expires_in` can make every API call refresh (rate-limit problem).
 */

import {
  GOOGLE_TOKEN_URL,
  GmailError,
  type AuthErrorKind,
  type TokenSet,
} from "./dto";

/** Refresh this far before the real expiry, so an in-flight request cannot expire. */
export const EXPIRY_SLACK_MS = 60_000;

/** The floor on a stored lifetime. See the header. */
export const MIN_STORED_LIFETIME_MS = EXPIRY_SLACK_MS + 5_000;

/**
 * Where a token set lives.
 *
 * Desktop backs with OS keychain (Rust command in `platform/desktop.ts`), web
 * with `localStorage`. A refresh token in `localStorage` is readable by XSS on
 * the page; not so in the keychain.
 */
export interface TokenStore {
  read(): Promise<TokenSet | null>;
  write(tokens: TokenSet): Promise<void>;
  clear(): Promise<void>;
}

export type FetchLike = typeof globalThis.fetch;

export type TokenManagerOptions = {
  store: TokenStore;
  /** A fixed client id. Ignored when `client` is given. */
  clientId?: string;
  /**
   * A fixed client secret. Required by Google for a Web application client; optional
   * for a Desktop app client, where it is not confidential. Ignored when `client` is
   * given.
   */
  clientSecret?: string;
  /**
   * The user's own OAuth client, read when a request needs it.
   *
   * Winnow ships no client: the user pastes theirs into the setup screen, and it can
   * change or disappear while the app runs. Reading it per request rather than at
   * construction is what lets a changed client take effect without a reload.
   */
  client?: () => Promise<{ clientId: string; clientSecret?: string } | null>;
  fetchImpl?: FetchLike;
};

/** Thrown when no OAuth client has been set up. */
export const NO_CLIENT_MESSAGE =
  "Google sign-in isn't set up yet. Add your own Google OAuth client first.";

export class TokenManager {
  private tokens: TokenSet | null = null;
  private loaded = false;
  /** The in-flight refresh, shared by every concurrent caller. */
  private inflight: Promise<string> | null = null;
  /** Bumped on adopt and clear; a refresh that spans a bump is discarded. */
  private generation = 0;
  private loadError: string | null = null;

  constructor(private readonly options: TokenManagerOptions) {}

  /** The client to send, from the resolver if there is one. Throws when there is none. */
  private async resolveClient(): Promise<{ clientId: string; clientSecret?: string }> {
    const resolved = this.options.client
      ? await this.options.client()
      : this.options.clientId
        ? { clientId: this.options.clientId, clientSecret: this.options.clientSecret }
        : null;
    if (!resolved?.clientId) throw new GmailError(NO_CLIENT_MESSAGE, 0, "config");
    return resolved;
  }

  private get fetchImpl(): FetchLike {
    const impl = this.options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (!impl) throw new GmailError("no fetch implementation available", 0, "network");
    return impl;
  }

  /**
   * Load from the store once.
   *
   * A store failure is remembered separately from "no tokens" (e.g., "keychain
   * locked" vs "signed out"). The generation check prevents a read that resolves
   * after `clear()` from resurrecting tokens.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const generation = this.generation;
    try {
      const stored = await this.options.store.read();
      // Discarded if the session changed underneath the read.
      if (generation === this.generation) {
        this.tokens = stored;
        this.loadError = null;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.tokens = null;
        this.loadError = error instanceof Error ? error.message : String(error);
      }
    }
    this.loaded = true;
  }

  /** Whether a session exists, even a stale one. Decides silent restore. */
  async hasSession(): Promise<boolean> {
    await this.ensureLoaded();
    return this.tokens !== null;
  }

  /** The store's failure, if the store failed rather than being empty. */
  async storageError(): Promise<string | null> {
    await this.ensureLoaded();
    return this.loadError;
  }

  /** The currently stored tokens, for the settings panel. */
  async current(): Promise<TokenSet | null> {
    await this.ensureLoaded();
    return this.tokens;
  }

  /** Replace the session, e.g. after a successful code exchange. */
  async adopt(tokens: TokenSet): Promise<void> {
    this.generation += 1;
    this.tokens = tokens;
    this.loaded = true;
    this.loadError = null;
    try {
      await this.options.store.write(tokens);
    } catch {
      // An in-memory-only session still works for this run. The user is told
      // they will have to sign in again rather than being signed out mid-read.
    }
  }

  /** Forget the session. Any in-flight read or refresh is invalidated by the bump. */
  async clear(): Promise<void> {
    this.generation += 1;
    this.tokens = null;
    // Marked loaded so a read already in flight does not re-derive state from
    // the store on its way out; its result is discarded by the generation check.
    this.loaded = true;
    this.loadError = null;
    await this.options.store.clear().catch(() => undefined);
  }

  /**
   * A token good for at least `EXPIRY_SLACK_MS`, refreshing if needed.
   *
   * Returns `null` when there is no session, so callers treat "signed out" and
   * "expired" the same way.
   */
  async validAccessToken(): Promise<string | null> {
    await this.ensureLoaded();
    if (!this.tokens) return null;
    if (this.tokens.expiresAt - Date.now() > EXPIRY_SLACK_MS) return this.tokens.accessToken;
    return this.refresh();
  }

  /** Refresh unconditionally. Used after a 401, when the clock might lie. */
  async forceRefresh(): Promise<string | null> {
    await this.ensureLoaded();
    if (!this.tokens) return null;
    return this.refresh();
  }

  /**
   * The single-flight refresh.
   *
   * Every concurrent caller awaits the same promise, so a burst produces one
   * token request rather than many.
   */
  private refresh(): Promise<string> {
    if (this.inflight) return this.inflight;

    const generation = this.generation;
    const attempt = this.doRefresh(generation);
    this.inflight = attempt;

    // Cleared on settle, but only if this attempt still owns the slot: a forced
    // refresh started while it was in flight does. The `catch` is there so the
    // cleanup runs on rejection too — otherwise a failed refresh would leave a
    // rejected promise in the slot and every later caller would get the same
    // rejection forever, with no way to retry.
    void attempt
      .catch(() => undefined)
      .finally(() => {
        if (this.inflight === attempt) this.inflight = null;
      });

    return attempt;
  }

  private async doRefresh(generation: number): Promise<string> {
    const refreshToken = this.tokens?.refreshToken;
    if (!refreshToken) {
      // No refresh token — nothing to refresh with. `clear()` is skipped because
      // a token set may have been adopted while this refresh was in flight (see
      // generation check below), losing a perfectly good new session.
      const error = new GmailError("Sign in again to continue.", 401, "reauth_required");
      error.name = "GmailNoRefreshToken";
      throw error;
    }

    const client = await this.resolveClient();
    const body = new URLSearchParams({
      client_id: client.clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    // Sent only when the user's client has one.
    if (client.clientSecret) body.set("client_secret", client.clientSecret);

    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (error) {
      throw new GmailError(
        `Could not reach Google: ${error instanceof Error ? error.message : "network error"}`,
        0,
        "network",
      );
    }

    if (!response.ok) {
      const text = await response.text();

      // A wrong client secret is not a dead grant — do not clear the session;
      // checked before the 400/401 branch that would.
      if (text.includes("invalid_client")) {
        throw new GmailError(
          "Google rejected your OAuth client's credentials.",
          response.status,
          "invalid_client",
        );
      }

      // 400 and 401 mean "this grant is gone" (`invalid_grant` covers a revoked
      // token, an expired one, or a changed password). The user must re-auth.
      if (response.status === 400 || response.status === 401) {
        await this.clear();
        throw new GmailError(
          "Your Google session is no longer valid. Sign in again.",
          response.status,
          "reauth_required",
        );
      }
      throw new GmailError(`Google returned ${response.status}: ${text.slice(0, 200)}`, response.status);
    }

    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
      scope?: string;
    };

    // The generation moved while in flight: the user signed out, or a new
    // session was adopted. Drop the token rather than resurrecting the old
    // session.
    if (generation !== this.generation) {
      throw new GmailError("Sign in again to continue.", 401, "reauth_required");
    }

    const previous = this.tokens;
    const next: TokenSet = {
      accessToken: payload.access_token,
      // Google's refresh response omits the refresh token; it has not changed.
      refreshToken: previous?.refreshToken,
      expiresAt: Date.now() + Math.max((payload.expires_in ?? 3600) * 1000, MIN_STORED_LIFETIME_MS),
      scope: payload.scope ?? previous?.scope,
    };

    await this.adopt(next);
    return next.accessToken;
  }

  /** Exchange an authorization code for tokens. */
  async exchangeCode(args: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<TokenSet> {
    const client = await this.resolveClient();
    const body = new URLSearchParams({
      client_id: client.clientId,
      code: args.code,
      code_verifier: args.verifier,
      grant_type: "authorization_code",
      redirect_uri: args.redirectUri,
    });
    if (client.clientSecret) body.set("client_secret", client.clientSecret);

    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (error) {
      throw new GmailError(
        `Could not reach Google: ${error instanceof Error ? error.message : "network error"}`,
        0,
        "network",
      );
    }

    if (!response.ok) {
      const text = await response.text();
      const [message, kind] = describeTokenRejection(response.status, text);
      throw new GmailError(message, response.status, kind);
    }

    const payload = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    const tokens: TokenSet = {
      accessToken: payload.access_token,
      // A re-authorisation with `prompt=consent` always returns one; defensive
      // fallback avoids signing the user straight back out.
      refreshToken: payload.refresh_token ?? this.tokens?.refreshToken,
      expiresAt: Date.now() + Math.max((payload.expires_in ?? 3600) * 1000, MIN_STORED_LIFETIME_MS),
      scope: payload.scope,
    };

    await this.adopt(tokens);
    return tokens;
  }
}

/**
 * Turn a rejected token request into something a user can be told.
 *
 * Used by the code exchange. Google's own `error` and `error_description` are
 * echoed (truncated) because they distinguish a spent code from a mismatched
 * redirect URI. Remedies differ: `invalid_client` (or a missing
 * `client_secret`) means the user's OAuth client is wrong (missing or wrong secret, wrong
 * client type; cannot retry); `invalid_grant`/`invalid_request`
 * mean this attempt is wrong (spent code/replayed verifier/wrong redirect) — start
 * over; `redirect_uri_mismatch` means the exchange named a different URI than the
 * authorize request. Anything else is passed through, truncated.
 */
function describeTokenRejection(status: number, text: string): [string, AuthErrorKind] {
  const rejection = readGoogleRejection(text);
  const code = rejection?.error ?? "";
  // Google's own words — `error: error_description` — put inside the sentence,
  // because those are the only ones that tell a spent code from a mismatched
  // redirect URI. Dropped when the body is not JSON, where `includes` above
  // still catches the name.
  const quote = rejection
    ? `${rejection.error}${rejection.description ? `: ${rejection.description}` : ""}`
    : "";

  const missingSecret = code === "invalid_request" && /client_secret/i.test(rejection?.description ?? "");
  if (missingSecret || code === "invalid_client" || code === "unauthorized_client" || text.includes("invalid_client") || text.includes("unauthorized_client")) {
    return [
      `Google rejected your OAuth client's credentials${quote ? ` (${quote})` : ""}.`,
      "invalid_client",
    ];
  }
  if (code === "redirect_uri_mismatch" || text.includes("redirect_uri_mismatch")) {
    return [
      `Google rejected the token exchange because the redirect URI differed from the one used to sign in${quote ? ` (${quote})` : ""}. The authorize and token requests must name exactly the same URI — a redirect URI written differently in the two places, or the desktop's port placeholder reaching the exchange instead of the real port, reads as a mismatch here.`,
      "state_mismatch",
    ];
  }
  if (code === "invalid_grant" || code === "invalid_request" || text.includes("invalid_grant") || text.includes("invalid_request")) {
    return [
      `Google rejected this sign-in's authorization code${quote ? ` (${quote})` : ""}. A code is single-use and tied to the verifier and redirect URI of the attempt that issued it, so starting the sign-in again is the usual fix.`,
      "state_mismatch",
    ];
  }
  return [`Google returned ${status}: ${text.slice(0, 200)}`, "unknown"];
}

/**
 * Pull the `error` and `error_description` out of a Google token rejection.
 *
 * Google answers in JSON. The description is truncated and echoed inside a
 * sentence, not trusted as a verdict.
 */
function readGoogleRejection(text: string): { error: string; description?: string } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== "string") return null;
    const description = (parsed as { error_description?: unknown }).error_description;
    return {
      error,
      description: typeof description === "string" ? description.slice(0, 200) : undefined,
    };
  } catch {
    // Not JSON — the body still gets matched by name in `includes` above.
    return null;
  }
}

/**
 * A `TokenStore` backed by `localStorage`, for the web build.
 *
 * A half-written or hand-edited blob is treated as signed out (not a broken
 * store): if `JSON.parse` fails or the value is unusable, the item is removed so
 * the next read returns a clean "no session".
 */
export function localStorageTokenStore(key = "winnow.gmail.tokens"): TokenStore {
  return {
    async read() {
      const raw = globalThis.localStorage?.getItem(key);
      if (!raw) return null;
      let parsed: TokenSet;
      try {
        parsed = JSON.parse(raw) as TokenSet;
      } catch {
        globalThis.localStorage?.removeItem(key);
        return null;
      }
      if (!parsed?.accessToken) {
        globalThis.localStorage?.removeItem(key);
        return null;
      }
      return parsed;
    },
    async write(tokens) {
      globalThis.localStorage?.setItem(key, JSON.stringify(tokens));
    },
    async clear() {
      globalThis.localStorage?.removeItem(key);
    },
  };
}

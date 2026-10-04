/**
 * Tokens: storage, refresh, and the races around them.
 *
 * The hard part of a desktop mail client is not exchanging a code for a token.
 * It is that tokens expire hourly and *many things need them at once* — a sync
 * paging 200 messages, a list scrolling, a reply being sent. Three specific
 * failures had to be designed out:
 *
 *   1. **A burst of 401s triggering a burst of refreshes.** Fixed with
 *      single-flight: the first caller creates the refresh, everyone else awaits
 *      the same promise. One refresh, not forty.
 *   2. **A refresh completing after sign-out**, handing a token to code that no
 *      longer has a session. Fixed with a generation counter: every refresh
 *      captures the generation it started under, and a result is discarded if
 *      the generation moved while it was in flight.
 *   3. **`invalid_grant` treated as retryable.** It is not. It means the
 *      refresh token is revoked, which only re-authorising can fix, so the
 *      token set is cleared immediately and the user is told to sign in again.
 *
 * A fourth detail is easy to miss: the stored lifetime is floored at
 * `max(expires_in, 65)`. A pathological `expires_in` of 30 would otherwise make
 * every single API call refresh, turning a working session into a rate-limit
 * problem.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Gmail/Auth/TokenManager.swift`.
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
 * Implemented two ways, and the difference is the whole reason this is behind
 * an interface: the desktop build backs it with the OS keychain (a Rust command
 * in `platform/desktop.ts`), and the web build with `localStorage`. A refresh
 * token in `localStorage` is readable by any XSS on the page; the same token in
 * the macOS Keychain is not.
 */
export interface TokenStore {
  read(): Promise<TokenSet | null>;
  write(tokens: TokenSet): Promise<void>;
  clear(): Promise<void>;
}

export type FetchLike = typeof globalThis.fetch;

export type TokenManagerOptions = {
  store: TokenStore;
  clientId: string;
  /**
   * Only needed for the *web* flow, where the client is a confidential one and
   * the secret cannot be kept out of the bundle. The installed-app flow omits
   * it entirely, which is why the desktop build never sends one.
   */
  clientSecret?: string;
  fetchImpl?: FetchLike;
};

export class TokenManager {
  private tokens: TokenSet | null = null;
  private loaded = false;
  /** The in-flight refresh, shared by every concurrent caller. */
  private inflight: Promise<string> | null = null;
  /** Bumped on adopt and clear; a refresh that spans a bump is discarded. */
  private generation = 0;
  private loadError: string | null = null;

  constructor(private readonly options: TokenManagerOptions) {}

  private get fetchImpl(): FetchLike {
    const impl = this.options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (!impl) throw new GmailError("no fetch implementation available", 0, "network");
    return impl;
  }

  /**
   * Load from the store once.
   *
   * A store failure is remembered separately from "no tokens", because they
   * mean different things to the user: one is "you are signed out", the other
   * is "your keychain is locked". Conflating them produced a sign-in screen
   * that kept reappearing while the real problem was an unavailable keychain.
   *
   * The generation check is not paranoia. A keychain read is genuinely
   * asynchronous, so this can be in flight when the user hits "sign out" — and
   * without the guard the read resolves *after* `clear()` and puts the tokens
   * straight back, leaving a session that looks signed out and is not.
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
   * Returns `null` when there is no session, so callers can treat "signed out"
   * and "expired" as the same branch.
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
   * Every concurrent caller awaits the same promise, so a page of 200 messages
   * arriving at once produces one token request rather than two hundred.
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
      // No refresh token means there is nothing to refresh *with*, so the
      // session is over regardless of what the access token's expiry says.
      // `clear()` is deliberately skipped: it would wipe a token set that may
      // have been adopted while this refresh was in flight (see the generation
      // check below), losing a perfectly good new session.
      const error = new GmailError("Sign in again to continue.", 401, "reauth_required");
      error.name = "GmailNoRefreshToken";
      throw error;
    }

    const body = new URLSearchParams({
      client_id: this.options.clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    // Sent only when the flow needs it. A desktop build must never send one.
    if (this.options.clientSecret) body.set("client_secret", this.options.clientSecret);

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

      // A wrong client secret is not a dead grant, so it must not clear the
      // session — checked before the 400/401 branch below, which does. Wiping a
      // working session because the *build* is misconfigured would force a
      // re-authorisation that would fail the same way.
      if (text.includes("invalid_client")) {
        throw new GmailError(
          "Google rejected this build's client credentials.",
          response.status,
          "invalid_client",
        );
      }

      // 400 and 401 are the two that mean "this grant is gone": `invalid_grant`
      // covers a revoked token, an expired one, and a changed password. All
      // three need the user, not a retry.
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

    // The generation moved while we were in flight: the user signed out, or a
    // new session was adopted. This token belongs to a session that no longer
    // exists, so it is dropped rather than resurrected.
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
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      code: args.code,
      code_verifier: args.verifier,
      grant_type: "authorization_code",
      redirect_uri: args.redirectUri,
    });
    if (this.options.clientSecret) body.set("client_secret", this.options.clientSecret);

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
      // A re-authorisation with `prompt=consent` always returns one, but a
      // defensive fallback avoids signing the user straight back out.
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
 * Shared by the code exchange and the refresh, because Google answers the same
 * way for both and the wording should not drift between them.
 *
 * The three cases are separated because the remedy differs in each, and getting
 * that wrong sends people to the wrong place:
 *
 *   - `invalid_client` is the *build* being wrong — a missing secret, or the
 *     wrong client type. Retrying cannot help.
 *   - `invalid_grant` is this *attempt* being wrong — a spent code, a replayed
 *     verifier, a code issued for a different redirect URI. Start over.
 *   - anything else is passed through, truncated, because inventing a friendly
 *     message for an error we do not recognise is how a real bug gets reported
 *     as "something went wrong".
 */
function describeTokenRejection(status: number, text: string): [string, AuthErrorKind] {
  if (text.includes("invalid_client") || text.includes("unauthorized_client")) {
    return ["Google rejected this build's client credentials.", "invalid_client"];
  }
  if (text.includes("invalid_grant") || text.includes("invalid_request")) {
    // Deliberately vague: "invalid_grant" covers a replayed code as well as a
    // misused one, and saying which would tell an attacker what to fix.
    return ["Sign-in could not be verified. Please try again.", "state_mismatch"];
  }
  return [`Google returned ${status}: ${text.slice(0, 200)}`, "unknown"];
}

/**
 * A `TokenStore` backed by `localStorage`, for the web build.
 *
 * A half-written or hand-edited blob is treated as *signed out*, not as a broken
 * store: `JSON.parse` used to throw out of `read()`, which `ensureLoaded` records
 * as a storage failure, and the app then reported an unavailable store forever
 * with no way back in short of devtools. An unusable value is also removed, so
 * the next read is a clean "no session" rather than the same parse error again.
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

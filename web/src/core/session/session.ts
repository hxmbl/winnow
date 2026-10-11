/**
 * The sign-in and sync session.
 *
 * This is the layer that turns a signed-in account into a working inbox, and it
 * is deliberately separate from the store: the store owns *state*, this owns
 * *the backend*, and the store never knows whether its messages came from
 * Gmail, from a demo seed, or from a future IMAP account.
 *
 * The interesting part is the OAuth flow, which has two genuinely different
 * shapes. Both share PKCE and the token exchange; they differ only in how the
 * authorization code comes back:
 *
 *   - **Desktop.** A Rust loopback listener on an ephemeral port, and the system
 *     browser pointed at Google's authorize URL with a `redirect_uri` naming
 *     that port. The port is a placeholder until Rust binds it.
 *   - **Web.** A normal navigation to a redirect URI registered for the site,
 *     with the code read out of the URL on the way back.
 *
 * The state check is shared and non-negotiable: a redirect whose `state` does
 * not match the one we issued is rejected *before* any code is exchanged, so a
 * planted redirect cannot trade its own code for the user's tokens.
 */

import { GoogleAuthStateMissing } from "./errors";
import { clientIdFromEnv, webRedirectUriFromEnv } from "./env";
import {
  clearPendingAuth,
  forgetPendingAuth,
  rememberPendingAuth,
  takePendingAuth,
} from "./pendingAuth";
import { parseRedirect, readOwnParams, stripRedirect } from "./redirect";
import { GOOGLE_AUTH_URL, GMAIL_SCOPE, GmailError, LABEL } from "../gmail/dto";
import { buildAuthorizeUrl, createPkcePair, describeAuthError, stateMatches } from "../gmail/pkce";
import type { PlatformInfo } from "../../platform/types";
import { TokenManager } from "../gmail/tokens";
import { GmailClient } from "../gmail/client";
import { GmailSyncEngine, type MailboxCache, type CursorStore } from "../gmail/sync";
import { buildMime } from "../gmail/mime";
import { base64UrlDecode } from "../gmail/dto";
import type { Email, GmailId, Mailbox } from "../model/email";
import { mailboxFor } from "../gmail/mapper";
import type { Platform } from "../../platform/types";
import type { MailBackend } from "../store/store";

export { clientIdFromEnv, webRedirectUriFromEnv } from "./env";

/**
 * The token the Rust listener replaces with the port it bound.
 *
 * Must stay in step with `PORT_PLACEHOLDER` in
 * `native/src-tauri/src/oauth.rs`. The arrangement is deliberate: the authorize
 * URL is built here, alongside all the other OAuth logic, but the *port* is not
 * knowable until the OS hands one out. So the placeholder travels inside the URL
 * and Rust substitutes it — which is what makes it impossible for the URL and
 * the listener to name different ports, the failure that would otherwise send
 * Google to a dead port and hang the sign-in until it timed out.
 */
export const LOOPBACK_PORT_PLACEHOLDER = "__WINNOW_LOOPBACK_PORT__";

/** The loopback redirect URI, with the port left for Rust to fill in. */
export const LOOPBACK_REDIRECT_URI =
  `http://127.0.0.1:${LOOPBACK_PORT_PLACEHOLDER}/winnow-oauth`;

/**
 * How long to wait for the user to finish at Google.
 *
 * Long, because the flow is: click, switch to a browser, possibly create an
 * account, read a consent screen, pick four scopes, come back. Five minutes is
 * about the floor for someone doing that for the first time, and a timeout that
 * fires while they are still choosing produces a sign-in screen that looks broken
 * at the exact moment they were about to succeed.
 *
 * Bounded anyway, because "unbounded" is not a timeout — a listener waiting
 * forever is a listener that outlives the app's willingness to explain itself.
 */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** How long a pending cache write waits for more writes to join it. */
const FLUSH_DEBOUNCE_MS = 250;

/** Wrap a value so it reads in a message — quoted, and visible when empty. */
function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * A cache backed by `localStorage` (web) or `storage` (desktop).
 *
 * Every method is individually guarded, and the reason is worth stating once: private
 * mode in Safari and a full quota both make `localStorage` *throw* rather than return
 * — and only on some of the accessors. Three of these six were unguarded, so a user
 * with storage disabled got a working offline cache out of `all()` and then a thrown
 * exception out of `write()` the first time a sync saved a cursor, which surfaced
 * mid-sync as a failed refresh on an account that had just worked. Storage being
 * unavailable is not a reason to fail; it is a reason to do less.
 *
 * ## Why this holds the mailbox in memory
 *
 * The obvious implementation — read the blob, merge, write the blob, per call — is
 * quadratic, and quadratically *in the one place that cannot afford it*. Sync
 * upserts every 25 messages (`BATCH_SIZE`), so a 2,500-message full sync ran 100
 * upserts, and each one parsed and re-serialised the entire mailbox: measured at
 * 1.36s and 6.15MB of allocation for a mailbox that is 6.15MB on disk. The cost is
 * not the writing, it is that every intermediate write is a full copy.
 *
 * So the mailbox is mirrored in memory and `localStorage` is treated as a *sink*,
 * not a store. Reads come from the mirror; mutations touch the mirror and coalesce
 * into a single flush. A full sync now serialises the mailbox once.
 *
 * ## Why the quota is no longer swallowed
 *
 * A full quota throws on `setItem`, and the old `catch` discarded it — so past
 * roughly 2,000 messages (measured: 6.15MB against a ~5MB origin quota) the cache
 * silently stopped persisting, on every launch, forever, while the comment claimed
 * "the next sync rebuilds it". It cannot: the next sync hits the same wall. Losing
 * the offline cache is survivable; being told you have it and not having it is not,
 * so `flush()` reports the failure and the sync engine surfaces it.
 */
export function localCache(key = "winnow.gmail.cache"): MailboxCache & CursorStore & { flush(): Promise<void> } {
  /**
   * The mirror, keyed by Gmail id.
   *
   * A `Map` and not an array because sync's inner loop is `upsert`, and an array
   * mirror still had to rebuild the whole index on every call to find what it was
   * replacing — quadratic in a much cheaper currency, but quadratic. Keyed, an
   * upsert is a put per message.
   *
   * Insertion order is the array's order, and `set` on an existing key keeps a
   * key's original position, so the persisted blob is ordered the same way it
   * was when this was a plain array.
   *
   * `null` until something reads it, so an account that never syncs never pays for
   * the initial parse.
   */
  let mirror: Map<GmailId, Email> | null = null;
  let flushHandle: ReturnType<typeof setTimeout> | null = null;
  /** The last persistence failure, or `null`. Reported by `flush()`. */
  let flushError: unknown = null;

  const readAll = (): Map<GmailId, Email> => {
    if (mirror) return mirror;
    try {
      const raw = globalThis.localStorage?.getItem(`${key}.messages`);
      const rows = raw ? (JSON.parse(raw) as Email[]) : [];
      mirror = new Map(rows.map((email) => [email.gmailId, email]));
    } catch {
      mirror = new Map();
    }
    return mirror;
  };

  /**
   * Push the mirror to storage now.
   *
   * Records the failure instead of discarding it. `flush()` is where it surfaces.
   */
  const writeNow = (): void => {
    if (!mirror) return;
    try {
      globalThis.localStorage?.setItem(`${key}.messages`, JSON.stringify([...mirror.values()]));
      flushError = null;
    } catch (error) {
      flushError = error ?? new Error("cache write failed");
    }
  };

  /**
   * Ask for a write, joining any already pending.
   *
   * The `flushHandle` check is the coalescing: the first mutation in a burst
   * schedules, and everything after it for the next 250ms rides along on that one
   * timer rather than each writing its own full copy.
   */
  const scheduleFlush = (): void => {
    if (flushHandle !== null) return;
    flushHandle = setTimeout(() => {
      flushHandle = null;
      writeNow();
    }, FLUSH_DEBOUNCE_MS);
  };

  /** Replace the mirror and schedule one write. */
  const setAll = (emails: readonly Email[]): void => {
    mirror = new Map(emails.map((email) => [email.gmailId, email]));
    scheduleFlush();
  };

  return {
    async all() {
      return [...readAll().values()].sort((a, b) => b.receivedAt - a.receivedAt);
    },
    async upsert(emails) {
      const rows = readAll();
      for (const email of emails) rows.set(email.gmailId, email);
      scheduleFlush();
    },
    async remove(gmailIds) {
      const rows = readAll();
      for (const gmailId of gmailIds) rows.delete(gmailId);
      scheduleFlush();
    },
    async gmailIds() {
      return [...readAll().keys()];
    },
    async keepOnly(gmailIds) {
      // Deleted rather than rebuilt: `keepOnly` runs over the whole cache at the
      // end of a full sync, and this is the one operation where the survivors are
      // usually *most* of the mailbox.
      const keep = new Set(gmailIds);
      const rows = readAll();
      for (const gmailId of [...rows.keys()]) {
        if (!keep.has(gmailId)) rows.delete(gmailId);
      }
      scheduleFlush();
    },
    async replace(emails) {
      setAll(emails);
    },
    async clear() {
      if (flushHandle !== null) {
        clearTimeout(flushHandle);
        flushHandle = null;
      }
      mirror = new Map();
      flushError = null;
      try {
        globalThis.localStorage?.removeItem(`${key}.messages`);
      } catch {
        // Nothing to do; the cache is already unreachable.
      }
    },

    /**
     * Write any pending change and report whether it stuck.
     *
     * Called by the sync engine immediately before it records a cursor. The
     * ordering is the point: a cursor says "the cache is a faithful copy as of
     * this history id", and that claim is only true if the cache actually landed.
     */
    async flush() {
      if (flushHandle !== null) {
        clearTimeout(flushHandle);
        flushHandle = null;
      }
      writeNow();
      if (flushError !== null) throw flushError;
    },

    async read() {
      try {
        return globalThis.localStorage?.getItem(`${key}.cursor`) ?? null;
      } catch {
        // No cursor means a full sync, which is slower and correct. Returning null
        // rather than throwing is what keeps a blocked-storage user signed in.
        return null;
      }
    },
    async write(historyId: string) {
      try {
        globalThis.localStorage?.setItem(`${key}.cursor`, historyId);
      } catch {
        // The next launch does a full sync. Nothing else is affected.
      }
    },
    async cursorClear() {
      try {
        globalThis.localStorage?.removeItem(`${key}.cursor`);
      } catch {
        // Already unreachable.
      }
    },
  } as MailboxCache & CursorStore & { cursorClear(): Promise<void>; flush(): Promise<void> };
}

/** The session: a token manager, a client, a sync engine, and a backend. */
export class GmailSession {
  readonly tokens: TokenManager;
  readonly client: GmailClient;
  readonly sync: GmailSyncEngine;

  constructor(
    private readonly platform: Platform,
    /** Kept on the instance: the backend needs it to resolve a numeric id. */
    private readonly cache: MailboxCache & CursorStore,
  ) {
    this.tokens = new TokenManager({
      store: platform.tokenStore(),
      clientId: clientIdFromEnv(),
      // Asked of the platform, not decided here: whether a secret is needed
      // follows from how Google classifies the client, which follows from where
      // the code runs. The desktop answer is always "no", and it is the platform
      // layer's job to know that rather than this file's.
      clientSecret: platform.oauthClientSecret(),
    });

    this.client = new GmailClient(
      () => this.tokens.validAccessToken(),
      {
        // A 401 triggers exactly one forced refresh and one retry. A second
        // 401 propagates, because that means the grant is gone.
        onUnauthorized: () => this.tokens.forceRefresh(),
      },
    );

    this.sync = new GmailSyncEngine({ client: this.client, cache, cursor: cache });
  }

  /** Whether a session exists — enough to skip the sign-in screen. */
  async hasSession(): Promise<boolean> {
    return this.tokens.hasSession();
  }

  /**
   * What this build can actually do.
   *
   * Asked of the platform rather than assumed, because the two flows differ in
   * ways the sign-in screen has to explain rather than discover: the desktop
   * exchanges without a client secret and gets a code back over a socket, while
   * the web build needs a registered redirect URI and a secret in the bundle.
   * A user staring at "Sign in" deserves to know which they are looking at.
   */
  async capabilities(): Promise<PlatformInfo> {
    return this.platform.info();
  }

  /** The signed-in address, for the account row. */
  async accountEmail(): Promise<string> {
    const profile = await this.client.profile();
    return profile.emailAddress;
  }

  /**
   * Run the OAuth flow to completion.
   *
   * Returns the address on success. Every failure — a declined consent screen,
   * a state mismatch, an unreachable Google — surfaces as a `GmailError` with a
   * `kind`, so the sign-in screen can say something specific rather than
   * "something went wrong".
   */
  async signIn(): Promise<{ email: string }> {
    const clientId = clientIdFromEnv();
    if (!clientId) {
      throw new GmailError(
        "This build has no Google client id, so it cannot sign in. Set VITE_GMAIL_CLIENT_ID and rebuild.",
        0,
        "config",
      );
    }

    const pkce = await createPkcePair();
    const redirectUri = await this.redirectUri();

    const authorizeUrl = buildAuthorizeUrl(GOOGLE_AUTH_URL, {
      clientId,
      scope: GMAIL_SCOPE,
      redirectUri,
      challenge: pkce.challenge,
      state: pkce.state,
    });

    // The web build is about to unload this page, taking every local with it.
    // Stashing the verifier is the only way the redirect back can exchange the
    // code; the desktop build does not need it and does not pay for it.
    rememberPendingAuth({ state: pkce.state, verifier: pkce.verifier, redirectUri });

    const outcome = await this.platform.beginSignIn({
      authorizeUrl,
      timeoutMs: SIGN_IN_TIMEOUT_MS,
    });

    if (outcome.kind === "cancelled") {
      forgetPendingAuth(pkce.state);
      throw new GmailError("Sign-in was cancelled.", 0, "declined");
    }

    if (outcome.kind === "timeout") {
      forgetPendingAuth(pkce.state);
      throw new GmailError(
        "Sign-in timed out. If you finished at Google, try again — the code is single-use.",
        0,
        "declined",
      );
    }

    if (outcome.kind === "unavailable") {
      // Not the user's doing, and not a decline: the listener never started, so
      // saying "cancelled" would tell them their click was ignored when in fact
      // nothing was listening. The half-finished verifier is dropped either way,
      // because it cannot be completed without a code that will never arrive.
      forgetPendingAuth(pkce.state);
      throw new GmailError(`The sign-in could not be started: ${outcome.detail}`, 0, "network");
    }

    if (outcome.kind === "error") {
      forgetPendingAuth(pkce.state);
      throw new GmailError(describeAuthError(outcome.error), 0, "declined");
    }

    if (!stateMatches(pkce.state, outcome.state)) {
      // A redirect we did not issue. Refusing here — before the exchange — is
      // the entire point of the `state` parameter. The two values go into the
      // message so a failing attempt says which half was wrong.
      forgetPendingAuth(pkce.state);
      throw new GmailError(
        `The redirect came back with state ${quote(outcome.state)}, which does not match the state this attempt issued (${quote(pkce.state)}).`,
        0,
        "state_mismatch",
      );
    }

    // Clear the stash whether or not the exchange works. Leaving a spent
    // verifier behind would let a replayed code find one waiting for it.
    const pending = takePendingAuth(pkce.state);

    await this.tokens.exchangeCode({
      code: outcome.code,
      // Prefer the stashed verifier: on the web the `pkce` local is from before
      // a navigation, and only the stash survived. On the desktop both agree,
      // and either source works.
      verifier: pending?.verifier ?? pkce.verifier,
      // The URI the authorize request actually carried, when the platform says
      // so. On the desktop that is the port-substituted URI Rust handed to the
      // browser, and Google rejects an exchange that names the placeholder
      // instead — see `LOOPBACK_REDIRECT_URI` and `desktop.ts`'s `redirectUriIn`.
      redirectUri: outcome.redirectUri ?? redirectUri,
    });

    const profile = await this.client.profile();
    return { email: profile.emailAddress };
  }

  /**
   * The redirect URI for this build.
   *
   * Two shapes, and which one is correct follows from how OAuth is *delivered*,
   * which is a platform capability:
   *
   *   - **Desktop** — the loopback URI, whose port is a placeholder Rust
   *     substitutes once the OS hands one out.
   *   - **Web** — a real, registered URI, because a page has no ability to bind
   *     a port and so cannot use the loopback one.
   *
   * The distinction has to be drawn from the platform, not from whether
   * `VITE_GMAIL_REDIRECT_URI` happens to be set. That variable is empty in a
   * desktop build by design, so `webRedirectUriFromEnv() || LOOPBACK_REDIRECT_URI`
   * read an empty value as "desktop" and — on a web build with no URI configured
   * — fell through to the loopback placeholder. The browser then navigated to
   * Google with `__WINNOW_LOOPBACK_PORT__` in the `redirect_uri`, which is a
   * well-formed URL naming a port nothing is listening on, so Google rejected it
   * with `Error 400: invalid_request` and the only clue was a token the code
   * never appears to build.
   *
   * A web build with no registered URI is a configuration error, and it says so
   * rather than sending a placeholder to Google. Desktop ignores the web variable
   * entirely, matching how it already ignores `VITE_GMAIL_CLIENT_SECRET`.
   */
  private async redirectUri(): Promise<string> {
    const { nativeOAuth } = await this.platform.info();
    if (nativeOAuth) return LOOPBACK_REDIRECT_URI;

    const configured = webRedirectUriFromEnv();
    if (!configured) {
      throw new GmailError(
        "This build has no Google redirect URI, so it cannot sign in. Set VITE_GMAIL_REDIRECT_URI to the URI registered for this site and rebuild.",
        0,
        "config",
      );
    }
    return configured;
  }

  /**
   * Finish a sign-in the browser delivered by navigating back.
   *
   * On the web this page was torn down and rebuilt while the user was at
   * Google, so there is no continuation to resume — the code is read out of the
   * URL and the verifier out of `sessionStorage`, keyed by `state`. Both must
   * match a sign-in this tab actually started.
   *
   * Returns `null` when there is no redirect in the URL, which is the ordinary
   * boot case: the app just loads and shows the inbox or the sign-in screen.
   */
  async completeWebRedirect(): Promise<{ email: string; view?: Record<string, string> } | null> {
    const location = globalThis.location;
    if (!location) return null;
    const redirect = parseRedirect(location.search);
    if (!redirect) return null;

    // Read the app's own parameters *before* the URL is scrubbed, and hand them
    // back so a shared link survives the sign-in round trip. Someone who sent
    // "?view=spam" to a signed-out colleague should land on spam, not on the
    // inbox — the trip to Google and back should not cost them the link.
    const shared = readOwnParams(location.search);

    if (redirect.kind === "cancelled") {
      // Not a shape `parseRedirect` produces, but the shared `OAuthRedirect` type
      // allows it and a caller can pass one in. Treated as "no redirect" rather
      // than as an error, which is what it means.
      return null;
    }

    if (redirect.kind === "error") {
      // A decline still carries the state we issued, so the stash can be dropped
      // rather than left to expire.
      if (redirect.state) forgetPendingAuth(redirect.state);
      throw new GmailError(describeAuthError(redirect.error), 0, "declined");
    }

    // A code with no state alongside it. `parseRedirect` already refuses this,
    // and the check is repeated here because the point being defended — no
    // exchange without proof the redirect is ours — is worth stating at the
    // point where the exchange happens.
    if (!redirect.state) {
      // No state to check against means no way to prove this redirect is ours.
      throw new GoogleAuthStateMissing(
        "the redirect carried no state parameter, so it cannot be tied to a sign-in this window started.",
      );
    }

    const pending = takePendingAuth(redirect.state);
    if (!pending) {
      // The state is well-formed but this tab has no verifier for it: either the
      // sign-in was started somewhere else, it expired, or storage was blocked.
      // Refusing is the safe answer — exchanging an unverified code is exactly
      // the attack the state parameter exists to stop. The message carries the
      // likeliest causes, because this is the single most confusing failure in
      // the flow — a dev builds the site, opens it at localhost, and Google
      // redirects to 127.0.0.1: a different origin, with no sessionStorage.
      const here = globalThis.location?.origin ?? "this origin";
      throw new GoogleAuthStateMissing(
        `no sign-in in progress issued state ${quote(redirect.state)} on ${here}. ` +
          "A verifier lives in this tab's own sessionStorage, for one tab and one origin — so this usually means the sign-in was started in another window or tab, the storage was cleared while you were at Google, or the redirect came back on a different origin (http://localhost vs http://127.0.0.1 is the classic case).",
      );
    }

    await this.tokens.exchangeCode({
      code: redirect.code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
    });

    // Leave no trace of the code in the address bar: it is a single-use secret
    // and there is no reason for it to survive in a link someone might copy.
    // `replaceState` rather than assigning, so the back button does not return
    // the user to a URL containing a spent code.
    const rest = stripRedirect(location.search);
    globalThis.history?.replaceState(null, "", `${location.pathname}${rest}${location.hash}`);

    const profile = await this.client.profile();
    return { email: profile.emailAddress, view: shared };
  }

  /** Forget the session. The cache is wiped too: it is the user's mail. */
  async signOut(): Promise<void> {
    await this.tokens.clear();
    // Any half-finished web sign-in goes too. A verifier left in
    // `sessionStorage` after the user explicitly signed out would let a later
    // redirect complete an exchange they did not ask for.
    clearPendingAuth();
    // The cache is the user's mail on disk. Wiping it on sign-out is not
    // tidiness: it is the difference between "signed out" and "signed out, but
    // the next person at this keyboard can read your inbox".
    await this.cache.clear();
  }

  /** A `MailBackend` the store can drive. */
  backend(): MailBackend {
    const client = this.client;
    const cache = this.cache;
    const engine = this.sync;

    /**
     * The cached messages, read once per operation.
     *
     * Both the id lookup and the reply's `References` header need the whole set,
     * and reading it twice per action would double a `localStorage` parse for no
     * reason.
     */
    const loadCache = (): Promise<Email[]> => cache.all();

    /** The gmail id for a numeric id — the API speaks ids, the UI does not. */
    const gmailIdFor = async (id: number): Promise<string> => {
      const cached = (await cache.all()).find((email) => email.id === id);
      if (!cached) {
        // A message the cache does not have cannot be acted on server-side
        // either: there is no id to send. A refresh is the fix.
        throw new GmailError(
          "That message is no longer cached. Refresh and try again.",
          404,
          "unknown",
        );
      }
      return cached.gmailId;
    };

    return {
      async sync(options) {
        // Progress is threaded from the store rather than invented here, so the
        // number on the status line is the engine's own count of messages it has
        // actually downloaded — not an estimate, and not a guess at what a
        // percentage would have been.
        const result = await engine.sync({ onProgress: options?.onProgress });
        return {
          emails: result.emails,
          failed: result.failed,
          truncated: result.truncated,
          // Forwarded rather than dropped: the store's notice is the only place the
          // user is told their offline cache did not save, and a flag that stops here
          // is a flag that is never seen.
          cacheUnpersisted: result.cacheUnpersisted,
        };
      },
      async toggleStar(id, starred) {
        await client.setStarred(await gmailIdFor(id), starred);
      },
      async moveToMailbox(id, mailbox) {
        const gmailId = await gmailIdFor(id);
        // The API expresses a move as label changes, so each destination is a
        // specific pair of adds and removes. Trash is additive; restoring has
        // to also re-add INBOX, or the message lands in limbo.
        switch (mailbox) {
          case "inbox":
            await client.removeLabels(gmailId, [LABEL.trash, LABEL.spam]);
            await client.addLabels(gmailId, [LABEL.inbox]);
            break;
          case "archive":
            await client.removeLabels(gmailId, [LABEL.trash, LABEL.spam, LABEL.inbox]);
            break;
          case "trash":
            await client.addLabels(gmailId, [LABEL.trash]);
            await client.removeLabels(gmailId, [LABEL.inbox]);
            break;
          case "spam":
            await client.addLabels(gmailId, [LABEL.spam]);
            await client.removeLabels(gmailId, [LABEL.inbox]);
            break;
        }
      },
      async setRead(id, read) {
        await client.markRead(await gmailIdFor(id), read);
      },
      async deletePermanently(id) {
        await client.deletePermanently(await gmailIdFor(id));
      },
      async sendReply(draft, inReplyTo) {
        const all = await loadCache();
        const email = all.find((candidate) => candidate.gmailId === inReplyTo);
        if (!email) {
          throw new GmailError(
            "Cannot reply: the original Gmail message is no longer cached. Refresh and try again.",
            404,
            "unknown",
          );
        }
        // A reply needs a `From`, and the only address Gmail will accept as
        // one is the account's own.
        const account = await client.profile();
        // `References` accumulates the whole exchange, oldest first, so that a
        // client threading this by references sees the same thread Gmail does.
        const conversation = email.threadId
          ? all.filter((candidate) => candidate.threadId === email.threadId)
          : [email];
        const raw = buildMime(draft as Parameters<typeof buildMime>[0], {
          from: { address: account.emailAddress, name: account.emailAddress.split("@")[0] },
          inReplyTo: email,
          references: conversation,
        });
        await client.send(raw, email.threadId);
      },

      async fetchAttachment(gmailId, attachmentId) {
        const all = await loadCache();
        const response = await client.attachment(gmailId, attachmentId);
        // Gmail returns base64url; the bytes are handed to the platform layer
        // which encodes them again for its own transport.
        const bytes = base64UrlDecode(response.data ?? "") ?? new Uint8Array(0);

        const email = all.find((candidate) => candidate.gmailId === gmailId);
        const attachment = email?.attachments.find((a) => a.id === attachmentId);
        return {
          bytes,
          filename: attachment?.filename ?? "attachment",
          mimeType: attachment?.mimeType ?? "application/octet-stream",
        };
      },

      async fetchBody(gmailId) {
        // One request, for one message, when someone opens it. The store keeps the
        // HTML body for a recent window precisely so this is rare — see
        // `BODY_RETENTION`.
        return client.messageBodyHtml(gmailId);
      },
    };
  }
}

/** Which mailbox a message belongs to, re-exported so callers need one import. */
export { mailboxFor };
export type { Email, Mailbox };

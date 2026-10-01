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
import { buildAuthorizeUrl, createPkcePair, describeAuthError } from "../gmail/pkce";
import type { PlatformInfo } from "../../platform/types";
import { TokenManager } from "../gmail/tokens";
import { GmailClient } from "../gmail/client";
import { GmailSyncEngine, type MailboxCache, type CursorStore } from "../gmail/sync";
import { buildMime, replyReferences } from "../gmail/mime";
import type { Email, Mailbox } from "../model/email";
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

/** A cache backed by `localStorage` (web) or `storage` (desktop). */
export function localCache(key = "winnow.gmail.cache"): MailboxCache & CursorStore {
  const readAll = (): Email[] => {
    try {
      const raw = globalThis.localStorage?.getItem(`${key}.messages`);
      return raw ? (JSON.parse(raw) as Email[]) : [];
    } catch {
      return [];
    }
  };

  const writeAll = (emails: readonly Email[]): void => {
    try {
      globalThis.localStorage?.setItem(`${key}.messages`, JSON.stringify(emails));
    } catch {
      // A full quota throws. The session keeps working from memory; only the
      // offline cache is lost, and the next sync rebuilds it.
    }
  };

  return {
    async all() {
      return readAll().sort((a, b) => b.receivedAt - a.receivedAt);
    },
    async upsert(emails) {
      const byId = new Map(readAll().map((email) => [email.gmailId, email]));
      for (const email of emails) byId.set(email.gmailId, email);
      writeAll([...byId.values()]);
    },
    async remove(gmailIds) {
      const drop = new Set(gmailIds);
      writeAll(readAll().filter((email) => !drop.has(email.gmailId)));
    },
    async gmailIds() {
      return readAll().map((email) => email.gmailId);
    },
    async keepOnly(gmailIds) {
      const keep = new Set(gmailIds);
      writeAll(readAll().filter((email) => keep.has(email.gmailId)));
    },
    async replace(emails) {
      writeAll(emails);
    },
    async clear() {
      try {
        globalThis.localStorage?.removeItem(`${key}.messages`);
      } catch {
        // Nothing to do; the cache is already unreachable.
      }
    },

    async read() {
      return globalThis.localStorage?.getItem(`${key}.cursor`) ?? null;
    },
    async write(historyId: string) {
      globalThis.localStorage?.setItem(`${key}.cursor`, historyId);
    },
    async cursorClear() {
      globalThis.localStorage?.removeItem(`${key}.cursor`);
    },
  } as MailboxCache & CursorStore & { cursorClear(): Promise<void> };
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
    const redirectUri = this.redirectUri();

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
      timeoutMs: 300_000,
    });

    if (outcome.kind === "cancelled") {
      forgetPendingAuth(pkce.state);
      throw new GmailError("Sign-in was cancelled.", 0, "declined");
    }

    if (outcome.kind === "error") {
      forgetPendingAuth(pkce.state);
      throw new GmailError(describeAuthError(outcome.error), 0, "declined");
    }

    if (outcome.state !== pkce.state) {
      // A redirect we did not issue. Refusing here — before the exchange — is
      // the entire point of the `state` parameter.
      forgetPendingAuth(pkce.state);
      throw new GmailError("Sign-in could not be verified. Please try again.", 0, "state_mismatch");
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
      redirectUri,
    });

    const profile = await this.client.profile();
    return { email: profile.emailAddress };
  }

  /**
   * The redirect URI for this build.
   *
   * The desktop listener's port is not knowable until the OS hands one out, so
   * the loopback URI carries a placeholder that Rust substitutes. The web build
   * needs a real, registered URI instead — and cannot use the loopback one,
   * because a page has no ability to bind a port.
   */
  private redirectUri(): string {
    return webRedirectUriFromEnv() || LOOPBACK_REDIRECT_URI;
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
      throw new GoogleAuthStateMissing();
    }

    const pending = takePendingAuth(redirect.state);
    if (!pending) {
      // The state is well-formed but this tab has no verifier for it: either the
      // sign-in was started somewhere else, it expired, or storage was blocked.
      // Refusing is the safe answer — exchanging an unverified code is exactly
      // the attack the state parameter exists to stop.
      throw new GoogleAuthStateMissing();
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
      async sync() {
        const result = await engine.sync();
        return { emails: result.emails, failed: result.failed };
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
          inReplyTo: email.gmailId,
          references: replyReferences(conversation),
        });
        await client.send(raw, email.threadId);
      },

      async fetchAttachment(gmailId, attachmentId) {
        const all = await loadCache();
        const response = await client.attachment(gmailId, attachmentId);
        const encoded = response.data ?? "";
        // Gmail returns base64url; the bytes are handed to the platform layer
        // which encodes them again for its own transport.
        const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

        const email = all.find((candidate) => candidate.gmailId === gmailId);
        const attachment = email?.attachments.find((a) => a.id === attachmentId);
        return {
          bytes,
          filename: attachment?.filename ?? "attachment",
          mimeType: attachment?.mimeType ?? "application/octet-stream",
        };
      },
    };
  }
}

/** Which mailbox a message belongs to, re-exported so callers need one import. */
export { mailboxFor };
export type { Email, Mailbox };

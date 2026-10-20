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

import { createIdleWriter, onPageLeave, type IdleScheduler } from "./idleWrite";
import { GoogleAuthStateMissing } from "./errors";
import { exchangeWithRetry, isFetchRejection, retryWhileUnreachable } from "./exchangeRetry";
import {
  testConnection,
  webRedirectUriFor,
  type ConnectionTest,
  type CredentialStore,
  type OAuthClientCredentials,
} from "./credentials";
import {
  clearPendingAuth,
  forgetPendingAuth,
  rememberPendingAuth,
  takePendingAuth,
} from "./pendingAuth";
import { parseRedirect, readOwnParams, stripRedirect } from "./redirect";
import { browserFallbackScope, refreshClientFor, scopeList, sessionStrandedBy } from "./nativeSignIn";
import {
  COMPOSE_SCOPE,
  DraftsScopeMissing,
  GOOGLE_AUTH_URL,
  GMAIL_SCOPE,
  GmailError,
  GmailHttpError,
  LABEL,
  hasDraftScopes,
  isInsufficientScope,
} from "../gmail/dto";
import { buildAuthorizeUrl, createPkcePair, describeAuthError, stateMatches } from "../gmail/pkce";
import type { NativeSignInResult, PlatformInfo } from "../../platform/types";
import { NO_CLIENT_MESSAGE, TokenManager } from "../gmail/tokens";
import { GmailClient } from "../gmail/client";
import { GmailSyncEngine, type MailboxCache, type CursorStore } from "../gmail/sync";
import { CONTACT_SCOPES, PeopleClient, PeopleScopeMissing, hasContactScopes } from "../gmail/people";
import { DRIVE_FILE_SCOPE, DriveClient, hasDriveScope, type DriveAccess, type DriveApi } from "../gmail/drive";
import {
  GoogleContactsSync,
  localContactsStore,
  type GoogleContact,
  type GoogleContactsStore,
} from "../contacts/google";
import { buildMime, type OutgoingAttachment } from "../gmail/mime";
import { notificationReplyDraft } from "../notify/notifications";
import { base64UrlDecode } from "../gmail/dto";
import { keepLoadedBody, withLoadedBody, type Draft, type Email, type GmailId, type Mailbox } from "../model/email";
import { loadedBodyOf, mailboxFor, toDraftEmail } from "../gmail/mapper";
import { mapPool } from "../gmail/pool";
import { SNOOZED_LABEL } from "../mail/snooze";
import type { Platform } from "../../platform/types";
import type { MailBackend } from "../store/store";


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

/** How many drafts the Drafts mailbox lists, newest first. */
export const DRAFTS_LIST_CAP = 100;

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
export function localCache(
  key = "winnow.gmail.cache",
  options: {
    /** When idle work runs; the browser's `requestIdleCallback` by default (tests drive it). */
    scheduler?: IdleScheduler;
    /** Calls back when the page is leaving, to write at once; `onPageLeave` by default. */
    lifecycle?: (flushNow: () => void) => () => void;
  } = {},
): MailboxCache & CursorStore & { flush(): Promise<void>; cursorClear(): Promise<void> } {
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
   * Hand a serialised mailbox to storage. Records the failure instead of discarding it;
   * `flush()` is where it surfaces.
   */
  const commit = (json: string): void => {
    try {
      globalThis.localStorage?.setItem(`${key}.messages`, json);
      flushError = null;
    } catch (error) {
      flushError = error ?? new Error("cache write failed");
    }
  };

  /**
   * The writer: every mutation asks for a write, and a burst of them shares one, which
   * runs in idle time and in chunks (`idleWrite.ts`) instead of stalling a frame. Leaving
   * the page writes whatever is pending at once.
   */
  const writer = createIdleWriter<Email>({
    rows: () => (mirror ? [...mirror.values()] : null),
    commit,
    scheduler: options.scheduler,
  });
  (options.lifecycle ?? onPageLeave)(() => {
    writer.flushNow();
  });
  const scheduleFlush = (): void => writer.schedule();

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
      // A metadata-only copy never overwrites a body already held: Gmail does not
      // change a message's content, and the reader may have loaded this one while the
      // sync that is now writing its metadata was still running.
      for (const email of emails) rows.set(email.gmailId, keepLoadedBody(email, rows.get(email.gmailId)));
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
      writer.cancel();
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
      // Pending or not: a flush always writes the mirror, so it reports on the
      // storage's real state rather than on a write that landed earlier.
      if (!writer.flushNow() && mirror) commit(JSON.stringify([...mirror.values()]));
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

/**
 * Where the user stands on Google contacts.
 *
 *   - `unavailable` — no session to ask with (signed out).
 *   - `not_granted` — signed in, but the contact scopes are not on the token. The opt-in
 *     is offered.
 *   - `granted` — both scopes are on the token; suggestions include the address book.
 */
export type ContactsAccess = "unavailable" | "not_granted" | "granted";

/** Whether the grant allows Gmail drafts. Same three states as contacts. */
export type DraftsAccess = "unavailable" | "not_granted" | "granted";

/** A finished web redirect, with what it was for when it was not a plain sign-in. */
export type CompletedWebRedirect = {
  email: string;
  view?: Record<string, string>;
  /**
   * Set when the redirect was the contacts opt-in: the access it ended with, or
   * `declined` — the user said no, or approved for another account.
   */
  contacts?: ContactsAccess | "declined";
  /** Why it was declined, in words, when it was. */
  contactsMessage?: string;
  /** Set when the redirect was the drafts opt-in, the same way as `contacts`. */
  drafts?: DraftsAccess | "declined";
  draftsMessage?: string;
  /** Set when the redirect was the Drive opt-in (large files as links), the same way. */
  drive?: DriveAccess | "declined";
  driveMessage?: string;
};

/** The refusal for a contacts consent approved for a different Google account. */
function wrongAccountMessage(actual: string, expected: string, what = "Google contacts were"): string {
  return `${what} approved for ${actual}, but Winnow is signed in as ${expected}. Choose ${expected} on Google's screen.`;
}

/** Google's refusal, worded for what was being asked. */
function describeOAuthError(error: string, purpose?: "contacts" | "drafts" | "drive"): string {
  if (purpose === "drive" && error === "access_denied") {
    return "Google Drive was not allowed, so the file was not sent as a link. Nothing was uploaded.";
  }
  if (purpose === "contacts" && error === "access_denied") {
    return "Google contacts were not connected. Suggestions keep coming from your mail.";
  }
  if (purpose === "drafts" && error === "access_denied") {
    return "Drafts were not allowed. Your draft is kept on this device instead.";
  }
  return describeAuthError(error);
}

/**
 * The cursor half of a combined cache.
 *
 * `localCache` is both a `MailboxCache` and a `CursorStore`, and the two interfaces
 * both have a `clear` — the intersection keeps the *cache's* (wipe the messages), and
 * the cursor's lives on as `cursorClear`. Handing the combined object to the engine as
 * its cursor meant every full sync began by wiping the message cache: a rebuild threw
 * away the copies "failed" is supposed to keep, the bodies metadata-first sync keeps,
 * and the mailbox on screen while the inbox re-filled. This adapter routes `clear` to
 * the cursor. A store without `cursorClear` gets an empty cursor written instead, which
 * `sync()` reads as "no cursor".
 */
export function cursorOf(store: CursorStore & { cursorClear?: () => Promise<void> }): CursorStore {
  return {
    read: () => store.read(),
    write: (historyId) => store.write(historyId),
    clear: async () => {
      if (typeof store.cursorClear === "function") return store.cursorClear();
      if (typeof store.write === "function") return store.write("");
    },
  };
}

/**
 * Ask the browser to keep this origin's storage (`navigator.storage.persist()`).
 *
 * `true` when granted. Best-effort and never throws: an engine without the API, or
 * one that refuses, is the same answer — and either way the write is retried after.
 * Note that persistence protects storage from eviction; it does not raise the
 * ~5MB `localStorage` ceiling, which metadata-first sync is what keeps us under.
 */
export async function requestPersistentStorage(
  nav: { storage?: { persist?: () => Promise<boolean> } } | undefined = globalThis.navigator,
): Promise<boolean> {
  try {
    const persist = nav?.storage?.persist;
    if (!persist) return false;
    return await persist.call(nav!.storage);
  } catch {
    return false;
  }
}

/**
 * A mailbox cache that ignores writes while `open()` says no.
 *
 * Sign-out wipes the cache, but work started before it does not stop: a sync that is
 * forty pages in still has responses on the wire, and each one it gets back is upserted,
 * and then flushed, into the cache that was just erased. Signing out halfway through a
 * first sync used to leave that half of the mailbox on disk. Reads still go through (they
 * see the empty cache), and `clear` is never gated.
 */
export function gatedCache<C extends MailboxCache & CursorStore>(cache: C, open: () => boolean): C {
  const gate =
    <A extends unknown[]>(write: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      if (open()) await write(...args);
    };
  return {
    ...cache,
    all: () => cache.all(),
    gmailIds: () => cache.gmailIds(),
    read: () => cache.read(),
    clear: () => cache.clear(),
    upsert: gate((emails: readonly Email[]) => cache.upsert(emails)),
    remove: gate((ids: readonly string[]) => cache.remove(ids)),
    keepOnly: gate((ids: readonly string[]) => cache.keepOnly(ids)),
    replace: gate((emails: readonly Email[]) => cache.replace(emails)),
    write: gate((historyId: string) => cache.write(historyId)),
    ...(cache.flush ? { flush: gate(() => cache.flush!()) } : {}),
  };
}

/** The same gate for the address book: a contacts refresh can outlive a sign-out too. */
export function gatedContacts(store: GoogleContactsStore, open: () => boolean): GoogleContactsStore {
  return {
    read: () => store.read(),
    clear: () => store.clear(),
    write: async (snapshot) => {
      if (open()) await store.write(snapshot);
    },
  };
}

/** The session: a token manager, a client, a sync engine, and a backend. */
export class GmailSession {
  readonly tokens: TokenManager;
  readonly client: GmailClient;
  readonly sync: GmailSyncEngine;
  readonly contacts: GoogleContactsSync;
  /** The user's own OAuth client. See `credentials.ts`. */
  readonly credentials: CredentialStore;

  /**
   * Whether work may still write to this account's storage. Closed by `signOut` before
   * anything is erased and opened again by the next successful code exchange, so a sync
   * or contacts refresh still in flight from before the sign-out cannot put back what it
   * erased. See `gatedCache`.
   */
  private writable = true;

  /** The cache as everything except `signOut` sees it: writes dropped while signed out. */
  private readonly cache: MailboxCache & CursorStore;

  constructor(
    private readonly platform: Platform,
    /** Kept on the instance: the backend needs it to resolve a numeric id. */
    private readonly rawCache: MailboxCache & CursorStore,
    contactsStore: GoogleContactsStore = localContactsStore(),
  ) {
    this.cache = gatedCache(rawCache, () => this.writable);
    contactsStore = gatedContacts(contactsStore, () => this.writable);
    this.credentials = platform.credentialStore();
    this.tokens = new TokenManager({
      store: platform.tokenStore(),
      // Read per request from the user's own store: Winnow ships no client, and the
      // user can change or remove theirs while the app runs.
      // `issuedTo`: a native Android session is refreshed under the client it came from.
      client: async (issuedTo) => refreshClientFor(await this.credentials.read(), issuedTo),
    });

    this.client = new GmailClient(
      () => this.tokens.validAccessToken(),
      {
        // A 401 triggers exactly one forced refresh and one retry. A second
        // 401 propagates, because that means the grant is gone.
        onUnauthorized: () => this.tokens.forceRefresh(),
      },
    );

    this.sync = new GmailSyncEngine({ client: this.client, cache: this.cache, cursor: cursorOf(this.cache) });

    // The same tokens and one-refresh-after-401 rule; its own quota bucket.
    const people = new PeopleClient(() => this.tokens.validAccessToken(), {
      onUnauthorized: () => this.tokens.forceRefresh(),
    });
    this.contacts = new GoogleContactsSync({ client: people, store: contactsStore });
  }

  /** Whether the stored grant includes the contact scopes. Read from the token, not asked. */
  async contactsAccess(): Promise<ContactsAccess> {
    const current = await this.tokens.current();
    if (!current) return "unavailable";
    return hasContactScopes(current.scope) ? "granted" : "not_granted";
  }

  /**
   * Refresh Google contacts, if the grant allows it.
   *
   * Returns the merged list, or `null` when there is no grant — including a grant that
   * was revoked at Google since the token was issued, in which case the local copy is
   * erased: the user took the permission back, and keeping what it let us read would be
   * ignoring them.
   */
  async refreshContacts(): Promise<GoogleContact[] | null> {
    if ((await this.contactsAccess()) !== "granted") return null;
    try {
      return await this.contacts.refresh();
    } catch (error) {
      if (error instanceof PeopleScopeMissing) {
        await this.contacts.clear();
        return null;
      }
      throw error;
    }
  }

  /**
   * Ask Google for the two contact scopes, on top of the existing grant.
   *
   * Incremental consent: `include_granted_scopes=true` makes the new token carry Gmail
   * access too, so nothing already working is lost, and only the contact scopes are
   * named, so the consent screen shows exactly what is being added. `login_hint` points
   * Google at the account that is already signed in.
   *
   * Same platform flow as sign-in: loopback on the desktop; on the web the page
   * navigates away and `completeWebRedirect` finishes it.
   *
   * If the user picked a *different* Google account on the consent screen, the previous
   * tokens are put back and the attempt refused — adopting them would silently switch
   * the mailbox to another person's.
   */
  async grantContacts(): Promise<ContactsAccess> {
    const before = await this.tokens.current();
    if (!before) {
      throw new GmailError("Sign in to Gmail before connecting Google contacts.", 401, "reauth_required");
    }
    const expected = (await this.client.profile()).emailAddress;

    await this.authorize(
      CONTACT_SCOPES.join(" "),
      { include_granted_scopes: "true", login_hint: expected },
      { purpose: "contacts", expectEmail: expected },
    );

    const actual = (await this.profileAfterAuthorize()).emailAddress;
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      await this.tokens.adopt(before);
      throw new GmailError(wrongAccountMessage(actual, expected), 0, "declined");
    }
    return this.contactsAccess();
  }

  /**
   * Whether the stored grant allows drafts. Read from the token, not asked. The sign-in
   * scope (`gmail.modify`) does, so this is `granted` for every normal session; the
   * check exists for a grant that was narrowed outside Winnow.
   */
  async draftsAccess(): Promise<DraftsAccess> {
    const current = await this.tokens.current();
    if (!current) return "unavailable";
    return hasDraftScopes(current.scope) ? "granted" : "not_granted";
  }

  /**
   * Ask for `gmail.compose` on top of the existing grant: the contacts opt-in's
   * incremental consent, with the same wrong-account refusal. On the web the page
   * navigates away; the composer's device copy restores the draft on the way back.
   */
  async grantDrafts(): Promise<DraftsAccess> {
    const before = await this.tokens.current();
    if (!before) {
      throw new GmailError("Sign in to Gmail before allowing drafts.", 401, "reauth_required");
    }
    const expected = (await this.client.profile()).emailAddress;
    await this.authorize(
      COMPOSE_SCOPE,
      { include_granted_scopes: "true", login_hint: expected },
      { purpose: "drafts", expectEmail: expected },
    );
    const actual = (await this.profileAfterAuthorize()).emailAddress;
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      await this.tokens.adopt(before);
      throw new GmailError(wrongAccountMessage(actual, expected, "Drafts were"), 0, "declined");
    }
    return this.draftsAccess();
  }

  /**
   * Whether the stored grant includes `drive.file` (large attachments as Drive links).
   * Read from the token, never stored apart from it: a sign-out revokes it with the rest.
   */
  async driveAccess(): Promise<DriveAccess> {
    const current = await this.tokens.current();
    if (!current) return "unavailable";
    return hasDriveScope(current.scope) ? "granted" : "not_granted";
  }

  /**
   * Ask for `drive.file` alone on top of the existing grant, the first time the user
   * chooses "Send as a Drive link": the drafts opt-in's incremental consent, with the
   * same wrong-account refusal. Never part of sign-in. On the web the page navigates away.
   */
  async grantDrive(): Promise<DriveAccess> {
    const before = await this.tokens.current();
    if (!before) {
      throw new GmailError("Sign in to Gmail before allowing Google Drive.", 401, "reauth_required");
    }
    const expected = (await this.client.profile()).emailAddress;
    await this.authorize(
      DRIVE_FILE_SCOPE,
      { include_granted_scopes: "true", login_hint: expected },
      { purpose: "drive", expectEmail: expected },
    );
    const actual = (await this.profileAfterAuthorize()).emailAddress;
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      await this.tokens.adopt(before);
      throw new GmailError(wrongAccountMessage(actual, expected, "Google Drive was"), 0, "declined");
    }
    return this.driveAccess();
  }

  /** A Drive client on this session's tokens (the same one-refresh-after-401 rule). */
  drive(): DriveApi {
    return new DriveClient(() => this.tokens.validAccessToken(), {
      onUnauthorized: () => this.tokens.forceRefresh(),
    });
  }

  /** The stored OAuth client, or `null` when the user has not set one up. */
  async storedCredentials(): Promise<OAuthClientCredentials | null> {
    try {
      return await this.credentials.read();
    } catch {
      return null;
    }
  }

  /**
   * Save a new OAuth client.
   *
   * A session made with a different client is signed out first: its refresh token
   * belongs to the old client, and Google refuses to refresh it under another one.
   */
  async saveCredentials(next: OAuthClientCredentials): Promise<{ signedOut: boolean }> {
    const previous = await this.storedCredentials();
    const sessionClient = (await this.tokens.current().catch(() => null))?.clientId;
    const changed = sessionStrandedBy(previous, next, sessionClient);
    let signedOut = false;
    if (changed && (await this.tokens.hasSession())) {
      await this.signOut();
      signedOut = true;
    }
    await this.credentials.write(next);
    return { signedOut };
  }

  /** Remove the OAuth client. Signs out first, because nothing can refresh without it. */
  async removeCredentials(): Promise<{ signedOut: boolean }> {
    const hadSession = await this.tokens.hasSession();
    // Always run: it also clears any half-finished sign-in and the cached mail.
    await this.signOut();
    await this.credentials.clear();
    return { signedOut: hadSession };
  }

  /** Ask Google whether it recognises a client, without signing in. */
  async testCredentials(candidate: OAuthClientCredentials): Promise<ConnectionTest> {
    const { nativeOAuth } = await this.platform.info();
    // Any well-formed loopback URI will do: the made-up code is refused before the
    // redirect URI is compared.
    const redirectUri = nativeOAuth ? "http://127.0.0.1:1/winnow-oauth" : webRedirectUriFor(globalThis.location);
    const main = await testConnection(candidate, redirectUri);
    if (!main.ok || !candidate.nativeAndroid) return main;
    // The Android step's Web client too: the same made-up code, refused after the
    // client and its secret are checked. The redirect is never compared.
    const native = await testConnection(candidate.nativeAndroid, "https://localhost/winnow-oauth");
    if (native.ok) {
      return { ok: true, message: "Google recognised both clients. Connect to finish signing in." };
    }
    return { ok: false, message: `Android sign-in client: ${native.message}` };
  }

  /** The redirect URI the setup screen asks a web user to register. Empty on desktop. */
  async redirectUriToRegister(): Promise<string> {
    const { nativeOAuth } = await this.platform.info();
    return nativeOAuth ? "" : webRedirectUriFor(globalThis.location);
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
   * uses a Desktop app client and gets a code back over a socket, while the web
   * build uses a Web application client, with its secret, and a registered
   * redirect URI (the page's own address).
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
    await this.authorize(GMAIL_SCOPE);

    const profile = await this.profileAfterAuthorize();
    return { email: profile.emailAddress };
  }

  /**
   * The profile read that ends a native sign-in, with the same foreground wait and
   * resend as the code exchange (`retryWhileUnreachable`). It is the first Gmail call
   * on the new token, made in the same breath as the exchange — so on Android it too
   * left a WebView that was still behind the browser, and the Gmail client lets a
   * bare `TypeError: Failed to fetch` through. A profile read is safe to repeat.
   */
  private profileAfterAuthorize(): ReturnType<GmailClient["profile"]> {
    return retryWhileUnreachable(() => this.client.profile(), {
      retryable: isFetchRejection,
      waitForForeground: () => this.waitForForeground(),
    });
  }

  private waitForForeground(): Promise<unknown> {
    return this.platform.waitForForeground?.() ?? Promise.resolve();
  }

  /**
   * One authorize round trip, ending in an adopted token set.
   *
   * Shared by the sign-in (`GMAIL_SCOPE`) and the contacts opt-in (the contact scopes,
   * with `include_granted_scopes`), because everything about the trip is the same: PKCE,
   * the platform's redirect delivery, the state check before any exchange. On the web
   * this never returns — the page navigates to Google — and the code is exchanged by
   * `completeWebRedirect` when it comes back.
   */
  private async authorize(
    scope: string,
    extra: Record<string, string> = {},
    intent: { purpose?: "contacts" | "drafts" | "drive"; expectEmail?: string } = {},
  ): Promise<void> {
    const stored = await this.storedCredentials();
    const clientId = stored?.clientId;
    if (!clientId) throw new GmailError(NO_CLIENT_MESSAGE, 0, "config");

    const before = await this.tokens.current().catch(() => null);
    const incremental = Boolean(intent.purpose);
    if (await this.authorizeNatively(stored, scope, before, incremental)) return;
    scope = browserFallbackScope(scope, before, incremental);

    const pkce = await createPkcePair();
    const redirectUri = await this.redirectUri();

    const authorizeUrl = buildAuthorizeUrl(GOOGLE_AUTH_URL, {
      clientId,
      scope,
      redirectUri,
      challenge: pkce.challenge,
      state: pkce.state,
    }, extra);

    // The web build is about to unload this page, taking every local with it.
    // Stashing the verifier is the only way the redirect back can exchange the
    // code; the desktop build does not need it and does not pay for it.
    rememberPendingAuth({ state: pkce.state, verifier: pkce.verifier, redirectUri, ...intent });

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
      throw new GmailError(describeOAuthError(outcome.error, intent.purpose), 0, "declined");
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

    // Through `exchangeWithRetry`: on Android the code arrives while the WebView is
    // paused behind the browser, so the exchange waits for the app to be in front and
    // resends a request that never reached Google (never one Google answered).
    const code = outcome.code;
    await exchangeWithRetry(() => this.tokens.exchangeCode({
      code,
      // Prefer the stashed verifier: on the web the `pkce` local is from before
      // a navigation, and only the stash survived. On the desktop both agree,
      // and either source works.
      verifier: pending?.verifier ?? pkce.verifier,
      // The URI the authorize request actually carried, when the platform says
      // so. On the desktop that is the port-substituted URI Rust handed to the
      // browser, and Google rejects an exchange that names the placeholder
      // instead — see `LOOPBACK_REDIRECT_URI` and `desktop.ts`'s `redirectUriIn`.
      redirectUri: outcome.redirectUri ?? redirectUri,
    }), { waitForForeground: () => this.waitForForeground() });
    this.writable = true;
  }

  /**
   * Try native Android sign-in (`nativeSignIn.ts`). True when it signed in; false when
   * the browser flow should run instead. Throws only for a cancel.
   *
   * Every failure past the user's own "no" falls back, the exchange included: a wrong
   * Web client secret, or an Android client Google accepted on the phone but not for
   * this project, still leaves the browser sign-in that works. The reason is kept on
   * `lastNativeFallback` for tests and nothing else; the user is not told.
   */
  private async authorizeNatively(
    stored: OAuthClientCredentials | null,
    scope: string,
    before: { scope?: string } | null,
    incremental: boolean,
  ): Promise<boolean> {
    const server = stored?.nativeAndroid;
    if (!server || !this.platform.nativeGoogleSignIn) return false;

    // An incremental grant asks again for everything the session holds: the native
    // client may not be the one that granted it.
    const scopes = scopeList(incremental ? before?.scope : undefined, scope);
    let result: NativeSignInResult;
    try {
      result = await this.platform.nativeGoogleSignIn({ serverClientId: server.clientId, scopes });
    } catch (error) {
      result = { kind: "unavailable", reason: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    if (result.kind === "cancelled") throw new GmailError("Sign-in was cancelled.", 0, "declined");
    if (result.kind === "unavailable") {
      this.lastNativeFallback = `${result.reason}: ${result.detail}`;
      return false;
    }

    const code = result.code;
    try {
      await exchangeWithRetry(() => this.tokens.exchangeServerAuthCode({ code, client: server }), {
        waitForForeground: () => this.waitForForeground(),
      });
    } catch (error) {
      this.lastNativeFallback = `exchange: ${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
    this.lastNativeFallback = null;
    this.writable = true;
    return true;
  }

  /** Why the last native sign-in fell back to the browser, or `null`. For tests. */
  lastNativeFallback: string | null = null;

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
   * The web URI is the app's own address (see `webRedirectUriFor`): the page reads a
   * returning code wherever it is loaded, and it is the URI the setup screen shows the
   * user to register. Drawn from the platform rather than from the URL, so a desktop
   * webview never sends `tauri://localhost` to Google.
   */
  private async redirectUri(): Promise<string> {
    const { nativeOAuth } = await this.platform.info();
    if (nativeOAuth) return LOOPBACK_REDIRECT_URI;

    const here = webRedirectUriFor(globalThis.location);
    if (!here) {
      throw new GmailError(
        "This page has no web address to return to, so it cannot sign in. Open Winnow over http(s).",
        0,
        "config",
      );
    }
    return here;
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
  async completeWebRedirect(): Promise<CompletedWebRedirect | null> {
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
      const declined = redirect.state ? takePendingAuth(redirect.state) : null;
      if (declined?.purpose === "drafts" && (await this.tokens.hasSession())) {
        this.scrubAddressBar();
        const profile = await this.client.profile();
        return {
          email: profile.emailAddress,
          view: shared,
          drafts: "declined",
          draftsMessage: describeOAuthError(redirect.error, "drafts"),
        };
      }
      if (declined?.purpose === "drive" && (await this.tokens.hasSession())) {
        this.scrubAddressBar();
        const profile = await this.client.profile();
        return {
          email: profile.emailAddress,
          view: shared,
          drive: "declined",
          driveMessage: describeOAuthError(redirect.error, "drive"),
        };
      }
      if (declined?.purpose === "contacts" && (await this.tokens.hasSession())) {
        // Declining the contacts opt-in is not a failed sign-in: the Gmail session is
        // untouched, so the app comes back exactly as it was, minus the code in the URL.
        this.scrubAddressBar();
        const profile = await this.client.profile();
        return {
          email: profile.emailAddress,
          view: shared,
          contacts: "declined",
          contactsMessage: describeOAuthError(redirect.error, "contacts"),
        };
      }
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

    // Kept so a contacts opt-in approved for the wrong account can be undone.
    const before = pending.purpose ? await this.tokens.current() : null;

    const code = redirect.code;
    await exchangeWithRetry(() => this.tokens.exchangeCode({
      code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
    }));
    this.writable = true;

    this.scrubAddressBar();

    const profile = await this.client.profile();
    if (pending.purpose === "drafts") {
      const expectedEmail = pending.expectEmail;
      if (expectedEmail && before && profile.emailAddress.toLowerCase() !== expectedEmail.toLowerCase()) {
        await this.tokens.adopt(before);
        return {
          email: expectedEmail,
          view: shared,
          drafts: "declined",
          draftsMessage: wrongAccountMessage(profile.emailAddress, expectedEmail, "Drafts were"),
        };
      }
      return { email: profile.emailAddress, view: shared, drafts: await this.draftsAccess() };
    }
    if (pending.purpose === "drive") {
      const expectedEmail = pending.expectEmail;
      if (expectedEmail && before && profile.emailAddress.toLowerCase() !== expectedEmail.toLowerCase()) {
        await this.tokens.adopt(before);
        return {
          email: expectedEmail,
          view: shared,
          drive: "declined",
          driveMessage: wrongAccountMessage(profile.emailAddress, expectedEmail, "Google Drive was"),
        };
      }
      return { email: profile.emailAddress, view: shared, drive: await this.driveAccess() };
    }
    if (pending.purpose !== "contacts") return { email: profile.emailAddress, view: shared };

    const expected = pending.expectEmail;
    if (expected && before && profile.emailAddress.toLowerCase() !== expected.toLowerCase()) {
      // The same refusal as the desktop's `grantContacts`: another account's token would
      // silently switch the mailbox to someone else's.
      await this.tokens.adopt(before);
      return {
        email: expected,
        view: shared,
        contacts: "declined",
        contactsMessage: wrongAccountMessage(profile.emailAddress, expected),
      };
    }
    return { email: profile.emailAddress, view: shared, contacts: await this.contactsAccess() };
  }

  /**
   * Leave no trace of the code in the address bar: it is a single-use secret and there
   * is no reason for it to survive in a link someone might copy. `replaceState` rather
   * than assigning, so the back button does not return the user to a URL containing a
   * spent code.
   */
  private scrubAddressBar(): void {
    const location = globalThis.location;
    if (!location) return;
    const rest = stripRedirect(location.search);
    globalThis.history?.replaceState(null, "", `${location.pathname}${rest}${location.hash}`);
  }

  /**
   * Forget the session. The cache is wiped too: it is the user's mail.
   *
   * The grant is revoked at Google as well, best effort and not awaited (see
   * `TokenManager.clear`), unless `revoke: false` — the demo, which has no grant of its
   * own to end.
   */
  async signOut(options: { revoke?: boolean } = {}): Promise<void> {
    // First, before anything is erased: a sync or contacts refresh still running from
    // before this moment must not write the account back.
    this.writable = false;
    await this.tokens.clear({ revoke: options.revoke ?? true });
    // The address book is the user's data in the same sense the mail is.
    await this.contacts.clear().catch(() => undefined);
    // Any half-finished web sign-in goes too. A verifier left in
    // `sessionStorage` after the user explicitly signed out would let a later
    // redirect complete an exchange they did not ask for.
    clearPendingAuth();
    // The cache is the user's mail on disk. Wiping it on sign-out is not
    // tidiness: it is the difference between "signed out" and "signed out, but
    // the next person at this keyboard can read your inbox".
    await this.rawCache.clear();
    // And the cursor with it: a cursor left over an empty cache makes the next
    // sign-in sync incrementally — changes only — into an empty mailbox.
    await cursorOf(this.rawCache).clear().catch(() => undefined);
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
    const platform = this.platform;

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

    /**
     * The raw message for a draft or a send, and the thread it belongs on.
     *
     * With `replyTo`, the message it answers: `In-Reply-To`, `References` over the
     * whole exchange, and its thread id. A send insists on having that message
     * (`strict`); a draft save does not, and saves unthreaded rather than not at all.
     */
    /**
     * Bytes of files a reopened draft names by Gmail id, kept for this session: a draft's
     * message id (and so its attachment ids) changes on every save, so the first save
     * after reopening is the last time those ids can be read.
     */
    const sourceBytes = new Map<string, Uint8Array>();
    const SOURCE_BYTES_KEPT = 40;
    const attachmentsFor = async (draft: Draft): Promise<OutgoingAttachment[] | undefined> => {
      const files = draft.attachments ?? [];
      if (files.length === 0) return undefined;
      return Promise.all(
        files.map(async (file): Promise<OutgoingAttachment> => {
          if (file.data !== undefined) return { filename: file.filename, mimeType: file.mimeType, base64: file.data };
          const source = file.source;
          if (!source) throw new GmailError(`${file.filename} is no longer available. Attach it again.`, 400, "unknown");
          const key = `${source.gmailId}:${source.attachmentId}`;
          let bytes = sourceBytes.get(key);
          if (!bytes) {
            const response = await client.attachment(source.gmailId, source.attachmentId);
            bytes = base64UrlDecode(response.data ?? "") ?? new Uint8Array(0);
            sourceBytes.set(key, bytes);
            while (sourceBytes.size > SOURCE_BYTES_KEPT) sourceBytes.delete(sourceBytes.keys().next().value!);
          }
          return { filename: file.filename, mimeType: file.mimeType, bytes };
        }),
      );
    };

    const rawFor = async (
      draft: Draft,
      replyTo?: GmailId,
      strict = false,
    ): Promise<{ raw: string; threadId?: string }> => {
      // A reply needs a `From`, and the only address Gmail will accept as one is the
      // account's own.
      const account = await client.profile();
      const from = { address: account.emailAddress, name: account.emailAddress.split("@")[0] };
      const attachments = await attachmentsFor(draft);
      if (!replyTo) return { raw: buildMime(draft, { from, attachments }), threadId: draft.threadId };
      const all = await loadCache();
      const email = all.find((candidate) => candidate.gmailId === replyTo);
      if (!email) {
        if (strict) {
          throw new GmailError(
            "Cannot reply: the original Gmail message is no longer cached. Refresh and try again.",
            404,
            "unknown",
          );
        }
        return { raw: buildMime(draft, { from, attachments }), threadId: draft.threadId };
      }
      // `References` accumulates the whole exchange, oldest first, so that a client
      // threading this by references sees the same thread Gmail does.
      const conversation = email.threadId
        ? all.filter((candidate) => candidate.threadId === email.threadId)
        : [email];
      return {
        raw: buildMime(draft, { from, inReplyTo: email, references: conversation, attachments }),
        threadId: email.threadId,
      };
    };

    /** A drafts request, with a scope refusal turned into the error the composer reads. */
    /** The `Winnow/Snoozed` label's id, looked up once (`setSnoozed`). */
    let snoozeLabel: Promise<string> | null = null;

    const draftCall = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        if (error instanceof GmailHttpError && isInsufficientScope(error.status, error.body)) {
          throw new DraftsScopeMissing();
        }
        throw error;
      }
    };

    return {
      async sync(options) {
        // Progress is threaded from the store rather than invented here, so the
        // number on the status line is the engine's own count of messages it has
        // actually downloaded — not an estimate, and not a guess at what a
        // percentage would have been.
        const result = await engine.sync({
          onProgress: options?.onProgress,
          onPartial: options?.onPartial,
        });
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
            // Not SENT: Gmail sets that label itself and rejects it in a modify call
            // with 400, which would fail every archive, not just archives of sent mail.
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
          case "snoozed":
          case "scheduled":
            // Views, not places: snoozing goes through `setSnoozed`, and a scheduled send
            // is a draft.
            throw new GmailError("Mail cannot be filed into a view.", 400, "unknown");
          case "drafts":
            // Unreachable too: a draft is listed through the drafts API, never filed.
            throw new GmailError("Mail cannot be filed into Drafts.", 400, "unknown");
          case "sent":
            // Unreachable: nothing in the product files mail into Sent, because the
            // label is set by Gmail at the moment it sends. Said rather than left
            // implicit, so adding a "file into Sent" action later finds this.
            throw new GmailError(
              "Mail cannot be filed into Sent — Gmail applies that label when it sends.",
              400,
              "unknown",
            );
        }
      },
      async setRead(id, read) {
        await client.markRead(await gmailIdFor(id), read);
      },
      async setSnoozed(gmailId, snoozed, options) {
        // The label is looked up (or made) once per session; a failure is not kept, so the
        // next snooze asks again.
        snoozeLabel ??= client.ensureLabel(SNOOZED_LABEL).catch((error: unknown) => {
          snoozeLabel = null;
          throw error;
        });
        const label = await snoozeLabel;
        if (snoozed) {
          await client.modify(gmailId, [label], [LABEL.inbox]);
          return;
        }
        const add = [
          ...(options?.toInbox === false ? [] : [LABEL.inbox]),
          ...(options?.unread ? [LABEL.unread] : []),
        ];
        await client.modify(gmailId, add, [label]);
      },
      async deletePermanently(id) {
        await client.deletePermanently(await gmailIdFor(id));
      },
      async sendReply(draft, inReplyTo, draftId) {
        const { raw, threadId } = await rawFor(draft as Draft, inReplyTo, true);
        // A composer with a saved draft sends *that* draft, with its latest content, so
        // Gmail removes it as it sends and no orphan is left in Drafts.
        if (draftId) await draftCall(() => client.sendDraft(draftId, raw, threadId));
        else await client.send(raw, threadId);
      },
      async sendNew(draft, draftId) {
        // The same `From` and the same builder as a reply, with no message to answer:
        // no `In-Reply-To`, no `References`, and no thread id for Gmail to file it under —
        // unless it is a reply reopened from Drafts whose original is not cached, which
        // carries its own headers and thread id (`Draft.replyHeaders`).
        const { raw, threadId } = await rawFor(draft);
        if (draftId) await draftCall(() => client.sendDraft(draftId, raw, threadId));
        else await client.send(raw, threadId);
      },

      async listDrafts(previous) {
        // `drafts.list` gives ids only, and a draft's message id changes every time it is
        // saved — so a row whose message id is unchanged is the same content, and only
        // new or edited drafts cost a `drafts.get`. Newest first, capped: Drafts is a
        // working set, not an archive.
        const listing = await draftCall(() => client.listDrafts(DRAFTS_LIST_CAP));
        const known = new Map(previous.map((email) => [email.gmailId, email]));
        const rows = await mapPool(listing.drafts ?? [], 8, async (entry) => {
          const messageId = entry.message?.id;
          const kept = messageId ? known.get(messageId) : undefined;
          if (kept && kept.gmailDraft?.id === entry.id) return kept;
          try {
            return toDraftEmail(await client.draft(entry.id));
          } catch (error) {
            // Sent or deleted between the listing and the fetch: gone, not a failure.
            if (error instanceof GmailHttpError && error.status === 404) return null;
            throw error;
          }
        });
        return rows
          .filter((row): row is Email => row !== null)
          .sort((a, b) => b.receivedAt - a.receivedAt);
      },

      async replyHeads(gmailIds) {
        // The composer's own path (`rawFor` → `buildMime`) for the notification's reply
        // with an empty body: everything but the text, which the native side appends.
        // One message failing (not cached any more) costs that message its Reply button.
        const all = await loadCache();
        const heads: Record<string, string> = {};
        for (const gmailId of gmailIds) {
          const email = all.find((candidate) => candidate.gmailId === gmailId);
          if (!email) continue;
          try {
            heads[gmailId] = (await rawFor(notificationReplyDraft(email), gmailId, true)).raw;
          } catch {
            // No head, no inline reply for this one; the notification still shows.
          }
        }
        return heads;
      },

      drafts: {
        async create(draft, replyTo) {
          const { raw, threadId } = await rawFor(draft, replyTo);
          return (await draftCall(() => client.createDraft(raw, threadId))).id;
        },
        async update(id, draft, replyTo) {
          const { raw, threadId } = await rawFor(draft, replyTo);
          return (await draftCall(() => client.updateDraft(id, raw, threadId))).id ?? id;
        },
        async delete(id) {
          await draftCall(() => client.deleteDraft(id));
        },
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

      async loadMessage(gmailId) {
        // The lazy half of metadata-first sync: one `format=full` request, decoded the
        // same way a full sync would have, and written into the offline cache so the
        // message reads offline from now on.
        const loaded = loadedBodyOf(await client.message(gmailId, "full"));
        const cached = (await cache.all()).find((email) => email.gmailId === gmailId);
        if (cached) await cache.upsert([withLoadedBody(cached, loaded)]);
        return loaded;
      },

      async persistCache() {
        // Web: ask for persistent storage first. Desktop: the webview's storage is the
        // app's own, so there is nothing to ask for — just retry the write.
        const kind = await platform.info().then((info) => info.kind, () => "web" as const);
        if (kind === "web") await requestPersistentStorage();
        try {
          await cache.flush?.();
          return true;
        } catch {
          return false;
        }
      },
    };
  }
}

/** Which mailbox a message belongs to, re-exported so callers need one import. */
export { mailboxFor };
export type { Email, Mailbox };

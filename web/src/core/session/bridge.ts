/**
 * Bridge between UI and the signed-in Gmail accounts.
 *
 * 1.4.0: several accounts, one open. Each account has its own `GmailSession` (its own
 * token entry, cache, cursor, contacts), its own offline queue and a light sync; the
 * flat methods below act on the **open** account, as they always did, and `accounts`
 * adds, switches and signs out of the rest. The OAuth client is shared: one Google
 * client, many grants.
 */

import {
  GmailSession,
  localCache,
  type CompletedWebRedirect,
  type ContactsAccess,
  type DraftsAccess,
} from "./session";
import type { Platform } from "../../platform/types";
import type { AccountState, AccountSummary, MailBackend, WinnowStore } from "../store/store";
import { localContactsStore, type GoogleContact } from "../contacts/google";
import type { DriveAccess, DriveApi } from "../gmail/drive";
import type { ConnectionTest, OAuthClientCredentials } from "./credentials";
import { OfflineQueue } from "../offline/queue";
import { GmailError } from "../gmail/dto";
import { parseRedirect } from "./redirect";
import { peekPendingAccount } from "./pendingAuth";
import {
  AccountRegistry,
  accountKey,
  newAccountId,
  scopedStorage,
  type AccountColor,
  type AccountRecord,
  type KeyValueStorage,
} from "./accounts";
import { adoptDeviceLearning, migrateToAccounts, type MigrationOutcome } from "./accountMigration";
import { LightSync } from "./lightSync";
import { loadAccountState, wipeAccountStorage } from "../store/accountState";
import type { Email } from "../model/email";

/** The namespace an account being added signs in under, until its address is known. */
export const PENDING_ACCOUNT = "pending";

/** The refusal past the cap. */
export const ACCOUNTS_FULL_MESSAGE = "Winnow holds five accounts at most. Sign out of one to add another.";

export type AddedAccount = { id: string; email: string; duplicate: boolean };

export type AccountsApi = {
  registry: AccountRegistry;
  /** The open account, or `null` (demo, signed out). */
  activeId(): string | null;
  /** Open another account: its cached mail at once, then a sync. */
  switchTo(id: string): Promise<void>;
  /**
   * Open the account the registry names as active (after a launch, a sign-in or a web
   * redirect): the store enters its namespace, shows its cached mail and connects.
   */
  openActive(): Promise<void>;
  /**
   * Sign in to one more account (Google's account chooser first) and make it the active
   * one; `openActive` opens it. One already added is not added again: it becomes the
   * active one instead, and says so (`duplicate`).
   */
  add(): Promise<AddedAccount>;
  /** Sign out of one account: its grant revoked and its namespace erased; the rest stay. */
  signOut(id: string, options?: { revoke?: boolean }): Promise<void>;
  /** Sign out of every account. */
  signOutAll(options?: { revoke?: boolean }): Promise<void>;
  setColor(id: string, color: AccountColor): void;
  setNotify(id: string, notify: boolean): void;
  /** The light sync of every account that is not open: unread counts and new mail. */
  checkInactive(): Promise<void>;
  /** A backend on an account that is not necessarily the open one (a From address, a notification). */
  backendFor(id: string): MailBackend | null;
};

export type SessionBridge = {
  /** Run the 1.3.5 → 1.4.0 migration and load the accounts. Everything else waits for it. */
  prepare(): Promise<MigrationOutcome>;
  accounts: AccountsApi;
  /** The user's stored OAuth client, or `null` before setup. */
  credentials(): Promise<OAuthClientCredentials | null>;
  /** Save an OAuth client. Sessions made with a different one are signed out. */
  saveCredentials(next: OAuthClientCredentials): Promise<{ signedOut: boolean }>;
  /** Remove the OAuth client and sign out of every account. */
  removeCredentials(): Promise<{ signedOut: boolean }>;
  /** Ask Google whether it recognises a client, without signing in. */
  testCredentials(candidate: OAuthClientCredentials): Promise<ConnectionTest>;
  /** The redirect URI a web user registers. Empty on the desktop. */
  redirectUriToRegister(): Promise<string>;
  /** Whether the open account has a session, even a stale one. */
  hasSession(): Promise<boolean>;
  /** The open account's address. */
  accountEmail(): Promise<string>;
  /**
   * The open account's address, read from Gmail, throwing (a `GmailError`) when the stored
   * session no longer works: unlike `accountEmail`, which falls back to a placeholder so a
   * launch still opens the cached mail. The demo's "Back to your inbox" asks this before
   * it lets the store leave the demo, so an expired grant never reaches `connect`.
   */
  verifiedAccountEmail(): Promise<string>;
  /**
   * Sign in. With no account yet, the first one; afterwards it is `accounts.add`. Throws
   * a `GmailError` on any failure.
   */
  signIn(): Promise<{ email: string; duplicate?: boolean }>;
  /** Finish a sign-in delivered via redirect. Returns null if no redirect. */
  completeWebRedirect(): Promise<CompletedWebRedirect | null>;
  /** The open account's store-facing backend, behind its offline queue. */
  backend(): MailBackend;
  /** The open account's offline queue; the "Offline: N changes waiting" line reads it. */
  readonly offlineQueue: OfflineQueue;
  /** Download one attachment's bytes. */
  fetchAttachment(
    gmailId: string,
    attachmentId: string,
  ): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
  /**
   * Sign out of the open account (see `accounts.signOut`); the next account opens, or the
   * app is signed out when it was the last. `revoke: false` skips the revoke, for the demo.
   */
  signOut(options?: { revoke?: boolean }): Promise<void>;
  contactsAccess(): Promise<ContactsAccess>;
  grantContacts(): Promise<ContactsAccess>;
  draftsAccess(): Promise<DraftsAccess>;
  grantDrafts(): Promise<DraftsAccess>;
  driveAccess(): Promise<DriveAccess>;
  grantDrive(): Promise<DriveAccess>;
  drive(): DriveApi;
  cachedContacts(): Promise<GoogleContact[]>;
  refreshContacts(): Promise<GoogleContact[] | null>;
  contactsSyncedAt(): Promise<number | null>;
};

/** How long a sign-out waits to take back a waiting send's Drive permissions. */
const SIGN_OUT_REVOKE_MS = 3_000;

type Entry = {
  id: string;
  session: GmailSession;
  queue: OfflineQueue;
  light: LightSync;
};

export type BridgeOptions = {
  /** Storage for everything but the tokens (`localStorage` by default). */
  storage?: KeyValueStorage | null;
  /** New mail in an account that is not open, for its notifications. */
  onInactiveMail?: (account: AccountRecord, emails: readonly Email[]) => void;
  /** Ids for new accounts (tests). */
  newId?: () => string;
  isOnline?: () => boolean;
};

function storageOf(options: BridgeOptions): KeyValueStorage | null {
  if (options.storage !== undefined) return options.storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Build a bridge over a `Platform`. */
export function createSessionBridge(platform: Platform, store: WinnowStore, options: BridgeOptions = {}): SessionBridge {
  const storage = storageOf(options);
  const isOnline = options.isOnline ?? (() => globalThis.navigator?.onLine ?? true);
  const registry = new AccountRegistry(storage);
  const entries = new Map<string, Entry>();
  /** Unread counts from the light sync, by account id. */
  const unread = new Map<string, number>();

  const entryFor = (id: string): Entry => {
    let entry = entries.get(id);
    if (entry) return entry;
    const session = new GmailSession(
      platform,
      localCache(undefined, { account: id }),
      localContactsStore(accountKey("winnow.google.contacts.v1", id)),
      { account: id },
    );
    const scoped = scopedStorage(storage, id);
    entry = {
      id,
      session,
      queue: new OfflineQueue({ storage: scoped, isOnline }),
      light: new LightSync(session.client, scoped),
    };
    entries.set(id, entry);
    return entry;
  };

  /** The session an account being added signs in with; replaced after each attempt. */
  let pending: GmailSession | null = null;
  const pendingSession = (): GmailSession => {
    pending ??= new GmailSession(
      platform,
      localCache(undefined, { account: PENDING_ACCOUNT }),
      localContactsStore(accountKey("winnow.google.contacts.v1", PENDING_ACCOUNT)),
      { account: PENDING_ACCOUNT },
    );
    return pending;
  };

  /** With no account open: the queue the indicator reads, always empty. */
  const idleQueue = new OfflineQueue({ storage: null, isOnline });

  const active = (): Entry | null => {
    const id = registry.snapshot().active;
    return id ? entryFor(id) : null;
  };

  /** The open account's session, or the pending one before any account exists. */
  const session = (): GmailSession => active()?.session ?? pendingSession();

  globalThis.addEventListener?.("online", () => active()?.queue.kick());

  const publish = (): void => {
    const activeId = registry.snapshot().active;
    const summaries: AccountSummary[] = registry.list().map((account) => ({
      id: account.id,
      email: account.email,
      color: account.color,
      notify: account.notify,
      unread: account.id === activeId ? null : (unread.get(account.id) ?? null),
      active: account.id === activeId,
    }));
    store.setAccounts(summaries);
  };
  registry.subscribe(publish);

  const backendFor = (entry: Entry): MailBackend =>
    entry.queue.wrap(entry.session.backend(), () => entry.session.accountEmail());

  /** Fill in an address the registry does not have yet (a migrated account). */
  const learnAddress = (id: string, email: string): void => {
    const record = registry.get(id);
    if (record && email && record.email.toLowerCase() !== email.toLowerCase()) registry.update(id, { email });
  };

  /**
   * Open `id`: leave the open account (its unread inbox seeds its light sync, its mirror
   * is let go), show the next account's cached mail, then connect it.
   */
  const open = async (id: string): Promise<void> => {
    const previous = active();
    if (previous && previous.id !== id) {
      const snap = store.getSnapshot();
      if (snap.accountId === previous.id) {
        previous.light.seed(snap.all.filter((email) => email.unread && email.mailbox === "inbox").map((email) => email.gmailId));
      }
      previous.session.releaseMemory();
    }
    registry.setActive(id);
    const entry = entryFor(id);
    unread.delete(id);
    const cached = await entry.session.cachedMail().catch(() => [] as Email[]);
    store.enterAccount(id, loadAccountState(storage, id) satisfies AccountState, cached);
    const record = registry.get(id);
    let email = record?.email ?? "";
    if (!email) {
      email = await entry.session.accountEmail().catch(() => "");
      learnAddress(id, email);
    }
    publish();
    await store.connect(backendFor(entry), { email: email || "your account" });
  };

  /**
   * An account signed in under `pending`: give it its namespace, or hand its fresh tokens
   * to the account that already has this address. The pending session is dropped either
   * way. Nothing is revoked for a duplicate: revoking would end the existing account's
   * grant too (one grant per client and Google account).
   */
  const settlePending = async (email: string): Promise<AddedAccount> => {
    const signedIn = pendingSession();
    pending = null;
    const tokens = await signedIn.tokens.current();
    await signedIn.tokens.clear({ revoke: false });
    if (!tokens) throw new GmailError("The sign-in finished without a session. Try again.", 0, "unknown");
    const existing = registry.byEmail(email);
    if (existing) {
      await entryFor(existing.id).session.tokens.adopt(tokens);
      return { id: existing.id, email: existing.email, duplicate: true };
    }
    if (!registry.canAdd()) {
      // Not this app's account: its fresh grant is taken back at Google.
      const outsider = new GmailSession(platform, localCache(undefined, { account: PENDING_ACCOUNT }), undefined, {
        account: PENDING_ACCOUNT,
      });
      await outsider.tokens.adopt(tokens);
      await outsider.tokens.clear({ revoke: true });
      throw new GmailError(ACCOUNTS_FULL_MESSAGE, 0, "declined");
    }
    const first = registry.list().length === 0;
    const id = (options.newId ?? newAccountId)();
    const added = registry.add(id, email);
    if ("kind" in added) throw new GmailError(ACCOUNTS_FULL_MESSAGE, 0, "declined");
    await entryFor(id).session.tokens.adopt(tokens);
    // What the device learned with no account (the demo, or a signed-out 1.3.5) goes to
    // the first account, as 1.3.5's learning followed whoever signed in.
    if (first) adoptDeviceLearning(storage, id);
    return { id, email: added.email, duplicate: false };
  };

  const signOutAccount = async (id: string, signOutOptions: { revoke?: boolean } = {}): Promise<void> => {
    const record = registry.get(id);
    if (!record) return;
    const entry = entryFor(id);
    const wasActive = registry.snapshot().active === id;
    // A send still waiting is abandoned by the sign-out: take back the Drive permissions
    // it made while the grant still works (bounded: never hold up a sign-out).
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      entry.queue.revokeQueuedShares(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SIGN_OUT_REVOKE_MS);
      }),
    ]);
    clearTimeout(timer);
    entry.queue.clear();
    try {
      await entry.session.signOut(signOutOptions);
    } finally {
      // Whatever the token store said, nothing of the account stays readable here.
      wipeAccountStorage(storage, id, record.email);
      entries.delete(id);
      unread.delete(id);
      registry.remove(id);
    }
    if (!wasActive) {
      publish();
      return;
    }
    const next = registry.snapshot().active;
    if (next) await open(next);
    else await store.signOut(loadAccountState(storage, null));
  };

  const accounts: AccountsApi = {
    registry,
    activeId: () => registry.snapshot().active,
    async switchTo(id) {
      if (!registry.get(id)) return;
      if (registry.snapshot().active === id && store.getSnapshot().accountId === id) return;
      await open(id);
    },
    async add() {
      if (!registry.canAdd()) throw new GmailError(ACCOUNTS_FULL_MESSAGE, 0, "declined");
      const signing = pendingSession();
      const { email } = await signing.signIn({ chooseAccount: registry.list().length > 0 });
      const added = await settlePending(email);
      registry.setActive(added.id);
      return added;
    },
    async openActive() {
      const id = registry.snapshot().active;
      if (!id) throw new GmailError("No account is signed in.", 401, "reauth_required");
      await open(id);
    },
    signOut: signOutAccount,
    async signOutAll(signOutOptions) {
      const activeId = registry.snapshot().active;
      for (const account of [...registry.list()].filter((a) => a.id !== activeId)) {
        await signOutAccount(account.id, signOutOptions);
      }
      if (activeId) await signOutAccount(activeId, signOutOptions);
      else if (store.getSnapshot().status !== "signed_out" && store.getSnapshot().contactsAccess !== "demo") {
        await store.signOut(loadAccountState(storage, null));
      }
    },
    setColor: (id, color) => registry.update(id, { color }),
    setNotify: (id, notify) => registry.update(id, { notify }),
    async checkInactive() {
      const activeId = registry.snapshot().active;
      for (const account of registry.list()) {
        if (account.id === activeId) continue;
        const entry = entryFor(account.id);
        try {
          if (!(await entry.session.hasSession())) continue;
          const result = await entry.light.check();
          unread.set(account.id, result.unread);
          if (result.fresh.length > 0 && account.notify) options.onInactiveMail?.(account, result.fresh);
        } catch {
          // A quiet account is better than an error about one that is not on screen;
          // its own sync says what is wrong once it is opened.
        }
      }
      publish();
    },
    backendFor(id) {
      if (!registry.get(id)) return null;
      return backendFor(entryFor(id));
    },
  };

  let prepared: Promise<MigrationOutcome> | null = null;

  const bridge: SessionBridge = {
    prepare() {
      prepared ??= (async () => {
        const outcome = await migrateToAccounts({
          storage,
          legacyTokens: platform.tokenStore(),
          tokensFor: (id) => platform.tokenStore(id),
        }).catch((error: unknown): MigrationOutcome => ({ kind: "deferred", reason: String(error) }));
        // The registry was read before the migration wrote it.
        registry.reload();
        publish();
        return outcome;
      })();
      return prepared;
    },

    accounts,

    credentials: () => session().storedCredentials(),

    async saveCredentials(next) {
      // One client for every account: a client change that strands one strands all.
      const result = await session().saveCredentials(next);
      if (result.signedOut) await accounts.signOutAll({ revoke: false });
      return result;
    },

    async removeCredentials() {
      const had = registry.list().length > 0;
      await accounts.signOutAll();
      await pendingSession().removeCredentials();
      return { signedOut: had };
    },

    testCredentials: (candidate) => session().testCredentials(candidate),

    redirectUriToRegister: () => session().redirectUriToRegister(),

    async hasSession() {
      const entry = active();
      return entry ? entry.session.hasSession() : false;
    },

    async accountEmail() {
      const entry = active();
      try {
        const email = await (entry?.session ?? pendingSession()).accountEmail();
        if (entry) learnAddress(entry.id, email);
        return email;
      } catch {
        // Stored session needs re-authorizing; fall back to the address the registry has.
        return registry.active()?.email || "your account";
      }
    },

    async verifiedAccountEmail() {
      const entry = active();
      const email = await session().accountEmail();
      if (entry) learnAddress(entry.id, email);
      return email;
    },

    async signIn() {
      if (registry.list().length > 0) {
        const added = await accounts.add();
        return { email: added.email, duplicate: added.duplicate };
      }
      const { email } = await pendingSession().signIn();
      const added = await settlePending(email);
      registry.setActive(added.id);
      return { email: added.email, duplicate: added.duplicate };
    },

    async completeWebRedirect() {
      const search = globalThis.location?.search ?? "";
      const redirect = parseRedirect(search);
      if (!redirect) return null;
      const state = "state" in redirect ? redirect.state : "";
      const namespace = state ? peekPendingAccount(state) : null;
      if (namespace === PENDING_ACCOUNT || (!namespace && !active())) {
        const completed = await pendingSession().completeWebRedirect();
        if (!completed) return null;
        const added = await settlePending(completed.email);
        registry.setActive(added.id);
        return { ...completed, email: added.email, ...(added.duplicate ? { duplicateAccount: true } : {}) };
      }
      const id = namespace && registry.get(namespace) ? namespace : registry.snapshot().active;
      if (!id) return null;
      if (id !== registry.snapshot().active) registry.setActive(id);
      return entryFor(id).session.completeWebRedirect();
    },

    backend() {
      const entry = active();
      if (!entry) throw new GmailError("No account is signed in.", 401, "reauth_required");
      return backendFor(entry);
    },

    get offlineQueue() {
      return active()?.queue ?? idleQueue;
    },

    fetchAttachment: (gmailId, attachmentId) => session().backend().fetchAttachment(gmailId, attachmentId),

    async signOut(signOutOptions) {
      const id = registry.snapshot().active;
      if (id) await signOutAccount(id, signOutOptions);
      else await store.signOut(loadAccountState(storage, null));
    },

    contactsAccess: () => session().contactsAccess(),
    grantContacts: () => session().grantContacts(),
    draftsAccess: () => session().draftsAccess(),
    grantDrafts: () => session().grantDrafts(),
    driveAccess: () => session().driveAccess(),
    grantDrive: () => session().grantDrive(),
    drive: () => session().drive(),
    cachedContacts: () => session().contacts.cached(),
    refreshContacts: () => session().refreshContacts(),
    contactsSyncedAt: () => session().contacts.lastSyncedAt(),
  };

  return bridge;
}

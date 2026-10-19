/**
 * Bridge between UI and signed-in Gmail account.
 */

import {
  GmailSession,
  localCache,
  type CompletedWebRedirect,
  type ContactsAccess,
  type DraftsAccess,
} from "./session";
import type { Platform } from "../../platform/types";
import type { MailBackend, WinnowStore } from "../store/store";
import type { GoogleContact } from "../contacts/google";
import type { DriveAccess, DriveApi } from "../gmail/drive";
import type { ConnectionTest, OAuthClientCredentials } from "./credentials";
import { OfflineQueue } from "../offline/queue";

export type SessionBridge = {
  /** The user's stored OAuth client, or `null` before setup. */
  credentials(): Promise<OAuthClientCredentials | null>;
  /** Save an OAuth client. A session made with a different one is signed out. */
  saveCredentials(next: OAuthClientCredentials): Promise<{ signedOut: boolean }>;
  /** Remove the OAuth client and sign out. */
  removeCredentials(): Promise<{ signedOut: boolean }>;
  /** Ask Google whether it recognises a client, without signing in. */
  testCredentials(candidate: OAuthClientCredentials): Promise<ConnectionTest>;
  /** The redirect URI a web user registers. Empty on the desktop. */
  redirectUriToRegister(): Promise<string>;
  /** Whether a session already exists, even a stale one. */
  hasSession(): Promise<boolean>;
  /** The signed-in address. */
  accountEmail(): Promise<string>;
  /**
   * The signed-in address, read from Gmail, throwing (a `GmailError`) when the stored
   * session no longer works: unlike `accountEmail`, which falls back to a placeholder so a
   * launch still opens the cached mail. The demo's "Back to your inbox" asks this before
   * it lets the store leave the demo, so an expired grant never reaches `connect`.
   */
  verifiedAccountEmail(): Promise<string>;
  /** Run the OAuth flow to completion. Throws a `GmailError` on any failure. */
  signIn(): Promise<{ email: string }>;
  /** Finish a sign-in delivered via redirect. Returns null if no redirect. */
  completeWebRedirect(): Promise<CompletedWebRedirect | null>;
  /** The store-facing backend, behind the offline queue (`core/offline/queue.ts`). */
  backend(): MailBackend;
  /** What is waiting to reach Gmail; the "Offline: N changes waiting" line reads it. */
  offlineQueue: OfflineQueue;
  /** Download one attachment's bytes. */
  fetchAttachment(
    gmailId: string,
    attachmentId: string,
  ): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
  /**
   * End the session and wipe the cached mail, and ask Google to revoke the grant (best
   * effort, never waited on). `revoke: false` skips the revoke, for the demo.
   */
  signOut(options?: { revoke?: boolean }): Promise<void>;
  /** Whether the grant includes Google contacts. */
  contactsAccess(): Promise<ContactsAccess>;
  /**
   * Ask for the contact scopes through incremental consent. On the web this navigates
   * away and never resolves; the outcome arrives through `completeWebRedirect`.
   */
  grantContacts(): Promise<ContactsAccess>;
  /** Whether the grant allows Gmail drafts. */
  draftsAccess(): Promise<DraftsAccess>;
  /** Ask for drafts through incremental consent; on the web this navigates away. */
  grantDrafts(): Promise<DraftsAccess>;
  /** Whether the grant includes `drive.file` (large attachments as Drive links). */
  driveAccess(): Promise<DriveAccess>;
  /** Ask for `drive.file` through incremental consent; on the web this navigates away. */
  grantDrive(): Promise<DriveAccess>;
  /** Drive on this session's tokens, for uploading and sharing a large attachment. */
  drive(): DriveApi;
  /** The address book as last stored, without the network. */
  cachedContacts(): Promise<GoogleContact[]>;
  /** Fetch what changed. `null` when there is no grant. */
  refreshContacts(): Promise<GoogleContact[] | null>;
  /** When contacts were last refreshed, or `null`. */
  contactsSyncedAt(): Promise<number | null>;
};

/** How long a sign-out waits to take back a waiting send's Drive permissions. */
const SIGN_OUT_REVOKE_MS = 3_000;

/** Build a bridge over a `Platform`. */
export function createSessionBridge(platform: Platform, store: WinnowStore): SessionBridge {
  const session = new GmailSession(platform, localCache());
  const offlineQueue = new OfflineQueue({
    storage: globalThis.localStorage ?? null,
    isOnline: () => globalThis.navigator?.onLine ?? true,
  });
  globalThis.addEventListener?.("online", () => offlineQueue.kick());

  const bridge: SessionBridge = {
    credentials: () => session.storedCredentials(),

    async saveCredentials(next) {
      const result = await session.saveCredentials(next);
      // The session half already wiped tokens and cache; the screen has to follow.
      if (result.signedOut) offlineQueue.clear();
      if (result.signedOut) await store.signOut();
      return result;
    },

    async removeCredentials() {
      const result = await session.removeCredentials();
      if (result.signedOut) offlineQueue.clear();
      if (result.signedOut) await store.signOut();
      return result;
    },

    testCredentials: (candidate) => session.testCredentials(candidate),

    redirectUriToRegister: () => session.redirectUriToRegister(),

    hasSession: () => session.hasSession(),

    async accountEmail() {
      try {
        return await session.accountEmail();
      } catch {
        // Stored session needs re-authorizing; fall back to issued account name.
        return "your account";
      }
    },

    verifiedAccountEmail: () => session.accountEmail(),

    signIn: () => session.signIn(),

    completeWebRedirect: () => session.completeWebRedirect(),

    backend: () => offlineQueue.wrap(session.backend(), () => session.accountEmail()),

    offlineQueue,

    fetchAttachment: (gmailId, attachmentId) =>
      session.backend().fetchAttachment(gmailId, attachmentId),

    async signOut(options) {
      // A send still waiting is abandoned by the sign-out: take back the Drive
      // permissions it made while the grant still works (bounded: never hold up a sign-out).
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        offlineQueue.revokeQueuedShares(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SIGN_OUT_REVOKE_MS);
        }),
      ]);
      clearTimeout(timer);
      offlineQueue.clear();
      await session.signOut(options);
      await store.signOut();
    },

    contactsAccess: () => session.contactsAccess(),

    grantContacts: () => session.grantContacts(),

    draftsAccess: () => session.draftsAccess(),

    grantDrafts: () => session.grantDrafts(),

    driveAccess: () => session.driveAccess(),

    grantDrive: () => session.grantDrive(),

    drive: () => session.drive(),

    cachedContacts: () => session.contacts.cached(),

    refreshContacts: () => session.refreshContacts(),

    contactsSyncedAt: () => session.contacts.lastSyncedAt(),
  };

  return bridge;
}

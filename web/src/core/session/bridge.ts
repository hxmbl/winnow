/**
 * Bridge between UI and signed-in Gmail account.
 */

import { GmailSession, localCache, type CompletedWebRedirect, type ContactsAccess } from "./session";
import type { Platform } from "../../platform/types";
import type { MailBackend, WinnowStore } from "../store/store";
import type { GoogleContact } from "../contacts/google";
import type { ConnectionTest, OAuthClientCredentials } from "./credentials";

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
  /** Run the OAuth flow to completion. Throws a `GmailError` on any failure. */
  signIn(): Promise<{ email: string }>;
  /** Finish a sign-in delivered via redirect. Returns null if no redirect. */
  completeWebRedirect(): Promise<CompletedWebRedirect | null>;
  /** The store-facing backend. */
  backend(): MailBackend;
  /** Download one attachment's bytes. */
  fetchAttachment(
    gmailId: string,
    attachmentId: string,
  ): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
  /** End the session and wipe the cached mail. */
  signOut(): Promise<void>;
  /** Whether the grant includes Google contacts. */
  contactsAccess(): Promise<ContactsAccess>;
  /**
   * Ask for the contact scopes through incremental consent. On the web this navigates
   * away and never resolves; the outcome arrives through `completeWebRedirect`.
   */
  grantContacts(): Promise<ContactsAccess>;
  /** The address book as last stored, without the network. */
  cachedContacts(): Promise<GoogleContact[]>;
  /** Fetch what changed. `null` when there is no grant. */
  refreshContacts(): Promise<GoogleContact[] | null>;
  /** When contacts were last refreshed, or `null`. */
  contactsSyncedAt(): Promise<number | null>;
};

/** Build a bridge over a `Platform`. */
export function createSessionBridge(platform: Platform, store: WinnowStore): SessionBridge {
  const session = new GmailSession(platform, localCache());

  const bridge: SessionBridge = {
    credentials: () => session.storedCredentials(),

    async saveCredentials(next) {
      const result = await session.saveCredentials(next);
      // The session half already wiped tokens and cache; the screen has to follow.
      if (result.signedOut) await store.signOut();
      return result;
    },

    async removeCredentials() {
      const result = await session.removeCredentials();
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

    signIn: () => session.signIn(),

    completeWebRedirect: () => session.completeWebRedirect(),

    backend: () => session.backend(),

    fetchAttachment: (gmailId, attachmentId) =>
      session.backend().fetchAttachment(gmailId, attachmentId),

    async signOut() {
      await session.signOut();
      await store.signOut();
    },

    contactsAccess: () => session.contactsAccess(),

    grantContacts: () => session.grantContacts(),

    cachedContacts: () => session.contacts.cached(),

    refreshContacts: () => session.refreshContacts(),

    contactsSyncedAt: () => session.contacts.lastSyncedAt(),
  };

  return bridge;
}

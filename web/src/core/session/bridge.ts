/**
 * Bridge between UI and signed-in Gmail account.
 */

import { GmailSession, localCache } from "./session";
import type { Platform } from "../../platform/types";
import type { MailBackend, WinnowStore } from "../store/store";

/** A finished web sign-in, plus the link target. */
export type CompletedRedirect = {
  email: string;
  view?: Record<string, string>;
};

export type SessionBridge = {
  /** Whether a session already exists, even a stale one. */
  hasSession(): Promise<boolean>;
  /** The signed-in address. */
  accountEmail(): Promise<string>;
  /** Run the OAuth flow to completion. Throws a `GmailError` on any failure. */
  signIn(): Promise<{ email: string }>;
  /** Finish a sign-in delivered via redirect. Returns null if no redirect. */
  completeWebRedirect(): Promise<CompletedRedirect | null>;
  /** The store-facing backend. */
  backend(): MailBackend;
  /** Download one attachment's bytes. */
  fetchAttachment(
    gmailId: string,
    attachmentId: string,
  ): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
  /** End the session and wipe the cached mail. */
  signOut(): Promise<void>;
};

/** Build a bridge over a `Platform`. */
export function createSessionBridge(platform: Platform, store: WinnowStore): SessionBridge {
  const session = new GmailSession(platform, localCache());

  const bridge: SessionBridge = {
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
  };

  return bridge;
}

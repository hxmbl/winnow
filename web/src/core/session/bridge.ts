/**
 * The bridge between the UI and a signed-in Gmail account.
 *
 * The app component does not import the Gmail layer — it is handed one of these
 * instead. Two things fall out of that:
 *
 *   - The demo path never constructs a token manager, a client or a sync engine,
 *     so there is nothing to accidentally fire a request at.
 *   - The wiring lives in one small function that can be read in one screen,
 *     rather than being spread across the component that renders the UI.
 *
 * The OAuth shape is chosen by the *platform*, not by the code here. On the
 * desktop, `platform.beginSignIn` opens the system browser and waits on a
 * loopback listener; on the web it navigates and reads the redirect out of the
 * URL. Both return the same `{ kind, code, state }` result, so this file has no
 * branch for it.
 */

import { GmailSession, localCache } from "./session";
import type { Platform } from "../../platform/types";
import type { MailBackend, WinnowStore } from "../store/store";

/**
 * A finished web sign-in, plus whatever the link was pointing at.
 *
 * `view` carries the app's own query parameters — `?view=spam&message=12` — so
 * that a shared link survives the trip to Google and back. Someone who was sent
 * a link to their spam folder and had to sign in first should land on their
 * spam folder, not on the inbox.
 */
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
  /**
   * Finish a sign-in the browser delivered by navigating back.
   *
   * Returns `null` when the current URL is not a redirect — the normal boot, and
   * the desktop's situation too, where the code never passed through the URL.
   * Must be called before `hasSession`, because a completed web redirect is the
   * thing that creates the session in the first place.
   */
  completeWebRedirect(): Promise<CompletedRedirect | null>;
  /** The store-facing backend. */
  backend(): MailBackend;
  /**
   * Download one attachment's bytes.
   *
   * Exposed on the bridge rather than only on the backend because it is the one
   * operation the reader performs directly: it is not a mutation, so it does not
   * belong in the optimistic-update path, and routing it through the backend
   * would mean reaching past the store for a read.
   */
  fetchAttachment(
    gmailId: string,
    attachmentId: string,
  ): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
  /** End the session and wipe the cached mail. */
  signOut(): Promise<void>;
};

/**
 * Build a bridge over a `Platform`.
 *
 * The cache is `localStorage` on both hosts, which is a deliberate
 * simplification rather than an oversight: the *tokens* go to the OS keychain on
 * the desktop, and the message cache is not a secret so much as a copy of mail
 * the user has already chosen to download. Putting it in IndexedDB instead would
 * buy nothing and cost a second serialisation path.
 */
export function createSessionBridge(platform: Platform, store: WinnowStore): SessionBridge {
  const session = new GmailSession(platform, localCache());

  const bridge: SessionBridge = {
    hasSession: () => session.hasSession(),

    async accountEmail() {
      try {
        return await session.accountEmail();
      } catch {
        // A stored session whose profile call fails is a session that needs
        // re-authorising, not a signed-in user with a bad address. So the
        // address falls back to whatever the token set was issued for, and the
        // next sync is what will discover whether it still works.
        return "your account";
      }
    },

    signIn: () => session.signIn(),

    completeWebRedirect: () => session.completeWebRedirect(),

    backend: () => session.backend(),

    fetchAttachment: (gmailId, attachmentId) =>
      session.backend().fetchAttachment(gmailId, attachmentId),

    async signOut() {
      // `session.signOut` already clears the pending sign-in stash; the store
      // half is what drops the mailbox from memory.
      await session.signOut();
      await store.signOut();
    },
  };

  return bridge;
}

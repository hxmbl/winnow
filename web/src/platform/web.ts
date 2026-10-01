/**
 * The browser platform.
 *
 * Every method here has a real, working browser implementation. That is the
 * point of the boundary: the web build is not a degraded desktop build, it is a
 * complete Winnow that happens to lack five OS conveniences — and the UI knows
 * which five, because `info()` says so.
 *
 * Two methods are honest no-ops, and both say why in a comment rather than
 * pretending:
 *
 *   - `setBackgroundSync` — a hidden tab is throttled to roughly one timer per
 *     minute, and a closed tab runs nothing at all. Pretending otherwise would
 *     mean burning quota on polls that cannot succeed.
 *   - `saveFile` — a browser cannot ask where a file goes. The download is
 *     still correct, it just lands wherever the browser puts downloads.
 */

import type { TokenStore } from "../core/gmail/tokens";
import { clientSecretFromEnv, webRedirectUriFromEnv } from "../core/session/env";
import { parseRedirect } from "../core/session/redirect";
import {
  webTokenStore,
  type NewMailNotification,
  type OAuthRedirect,
  type Platform,
  type PlatformInfo,
  type SignInRequest,
} from "./types";

/**
 * Where the in-flight `state` is kept.
 *
 * `sessionStorage` rather than a module variable: the page is destroyed and
 * rebuilt by the redirect, so anything held in a local is gone by the time
 * anyone asks "is a sign-in still pending?".
 */
const PENDING_STATE_KEY = "winnow.pendingState";

const WEB_INFO: PlatformInfo = {
  name: "Winnow",
  version: "0.1.0",
  os: "browser",
  arch: "unknown",
  kind: "web",
  nativeOAuth: false,
  nativeSecrets: false,
  backgroundSync: false,
  saveFiles: false,
};

/**
 * The browser platform, plus the two URL-reading helpers a browser sign-in
 * needs and a desktop build does not have.
 */
export type WebPlatform = Platform & {
  /** Read a completed redirect out of the current URL, if there is one. */
  readRedirectFromLocation(): OAuthRedirect | null;
  /** The `state` this page issued a sign-in with, if one is in flight. */
  pendingSignInState(): string | null;
};

export const webPlatform: WebPlatform = {
  async info() {
    return WEB_INFO;
  },

  tokenStore(): TokenStore {
    return webTokenStore();
  },

  /**
   * The configured secret, if the developer set one.
   *
   * Only a build that also has a registered *web* redirect URI uses it. A build
   * serving the web app from a loopback redirect is a desktop app in a tab, and
   * shipping it a secret would publish it for no benefit — so the desktop
   * redirect URI suppresses it.
   */
  oauthClientSecret(): string | undefined {
    if (!webRedirectUriFromEnv()) return undefined;
    return clientSecretFromEnv();
  },

  /**
   * Sign in by navigating away and reading the result on the way back.
   *
   * The desktop build's loopback listener cannot be reproduced here: a page has
   * no ability to bind a port. So the developer registers a real redirect URI
   * for the site, and this method reads it out of the current URL.
   */
  async beginSignIn(request: SignInRequest): Promise<OAuthRedirect> {
    // The verifier is stashed by the session; the state is recorded here so the
    // sign-in screen can show that something is in flight across the reload.
    try {
      const state = new URL(request.authorizeUrl).searchParams.get("state");
      if (state) globalThis.sessionStorage?.setItem(PENDING_STATE_KEY, state);
    } catch {
      // Storage blocked. The exchange still works — the session's own stash is
      // what matters — only the "signing in…" affordance is lost.
    }
    //
    // `location.assign` rather than `window.open`: a popup is blocked unless it
    // is opened synchronously from a user gesture, and this is awaited.
    globalThis.location?.assign(request.authorizeUrl);
    // Unreachable in a real navigation. The returned value exists only to
    // satisfy the shared `Platform` shape that the desktop build genuinely
    // resolves; if a browser ever *did* block the navigation, this surfaces as
    // a cancellation rather than a hang.
    return { kind: "cancelled" };
  },

  async cancelSignIn() {
    // Nothing to abort: the web flow's sign-in is a navigation the browser
    // controls. Backing out of the tab is the only way to cancel it, and
    // `history.back()` is the closest a page can get.
    try {
      globalThis.sessionStorage?.removeItem(PENDING_STATE_KEY);
    } catch {
      // Already unreachable; nothing to clear.
    }
    const href = globalThis.location?.href;
    if (href && href.startsWith("https://accounts.google.com")) {
      globalThis.history?.back();
    }
  },

  /**
   * Read a completed redirect out of the current URL.
   *
   * Called by the app on boot, not by `beginSignIn`, because the browser
   * navigates away and comes back — there is no continuation to resume. Parsing
   * is shared with the session, and scrubbing the URL happens there too, once,
   * after the code has actually been exchanged.
   */
  readRedirectFromLocation(): OAuthRedirect | null {
    const search = globalThis.location?.search;
    if (!search) return null;
    try {
      return parseRedirect(search);
    } catch {
      return null;
    }
  },

  /**
   * The `state` this page issued a sign-in with, if one is still in flight.
   *
   * Read from `sessionStorage` rather than a module variable, because a module
   * variable is reset by the very navigation that makes this necessary.
   */
  pendingSignInState(): string | null {
    try {
      const raw = globalThis.sessionStorage?.getItem(PENDING_STATE_KEY);
      return raw && raw.length > 0 ? raw : null;
    } catch {
      return null;
    }
  },

  async notifyNewMail(mail: NewMailNotification): Promise<void> {
    const NotificationCtor = globalThis.Notification;
    if (!NotificationCtor) return;
    if (NotificationCtor.permission === "granted") {
      new NotificationCtor(mail.title, { body: mail.body, tag: "winnow-new-mail" });
    } else if (NotificationCtor.permission === "default") {
      await NotificationCtor.requestPermission();
    }
  },

  async requestNotificationPermission(): Promise<boolean> {
    const NotificationCtor = globalThis.Notification;
    if (!NotificationCtor) return false;
    if (NotificationCtor.permission === "granted") return true;
    return (await NotificationCtor.requestPermission()) === "granted";
  },

  /**
   * The unread count, in the only place a browser can show one.
   *
   * `document.title` is the convention every tabbed mail client uses, and it is
   * visible without a notification permission.
   */
  async setUnreadBadge(count: number): Promise<void> {
    if (typeof document === "undefined") return;
    document.title = count > 0 ? `(${count}) Winnow` : "Winnow";
  },

  async setBackgroundSync(): Promise<void> {
    // Deliberately nothing. A hidden tab's timers are throttled past the point
    // of usefulness and a closed tab runs no JavaScript at all, so the honest
    // answer is that the web build syncs while it is open and not otherwise.
    // The store's own timer covers the open case.
  },

  onBackgroundTick(): () => void {
    return () => undefined;
  },

  async openExternal(url: string): Promise<void> {
    // `noopener` matters: the opened page must not get a handle on this one.
    globalThis.open?.(url, "_blank", "noopener,noreferrer");
  },

  async saveFile(filename: string, bytes: Uint8Array, mimeType: string): Promise<string | null> {
    // No dialog in a browser, so this is a download and there is no path to
    // report. The bytes are handed over as an object URL and revoked
    // immediately after the click, or the blob is retained for the page's life.
    const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Revoked on the next tick: revoking synchronously can cancel the download
    // in some browsers before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(href), 0);
    return null;
  },

  async focusWindow(): Promise<void> {
    globalThis.focus?.();
  },
};

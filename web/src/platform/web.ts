/**
 * Browser platform.
 */

import type { NotificationActionEvent } from "../core/notify/notifications";
import type { TokenStore } from "../core/gmail/tokens";
import { localStorageCredentialStore, type CredentialStore } from "../core/session/credentials";
import { parseRedirect } from "../core/session/redirect";
import {
  webTokenStore,
  type NewMailNotification,
  type OAuthRedirect,
  type Platform,
  type PlatformInfo,
  type SignInRequest,
  type SignInResult,
} from "./types";

const PENDING_STATE_KEY = "winnow.pendingState";
/**
 * Floor on the background interval, in seconds — the same floor the desktop
 * scheduler clamps to (`MIN_INTERVAL_SECS` in `scheduler.rs`). An incremental sync
 * that finds nothing is one `history.list` (2 quota units), so 30s is cheap.
 */
export const MIN_BACKGROUND_POLL_SECONDS = 30;

const WEB_INFO: PlatformInfo = {
  name: "Winnow",
  // Injected by `vite.config.ts` from package.json; absent under vitest.
  version: typeof __WINNOW_VERSION__ === "string" ? __WINNOW_VERSION__ : "0.0.0",
  os: "browser",
  arch: "unknown",
  kind: "web",
  nativeOAuth: false,
  nativeSecrets: false,
  backgroundSync: true,
  saveFiles: false,
};

export type WebPlatform = Platform & {
  /** Read a completed redirect out of the current URL, if there is one. */
  readRedirectFromLocation(): OAuthRedirect | null;
  /** The `state` this page issued a sign-in with, if one is in flight. */
  pendingSignInState(): string | null;
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollSeconds = 0;
let tickCounter = 0;
const tickHandlers = new Set<(tick: number) => void>();

function stopPolling(): void {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  pollSeconds = 0;
}

function fireTick(): void {
  tickCounter += 1;
  for (const handler of tickHandlers) handler(tickCounter);
}

/**
 * Background polling, at the user's interval, whether or not the tab is visible.
 *
 * While the tab is visible *and* focused, `foregroundSync.ts` polls faster and
 * `main.tsx` drops these ticks; this ticker is the slow cadence for a tab in the
 * background, which used to stop polling entirely. Browsers throttle timers in hidden
 * tabs (to once a minute or less), which is the right amount of politeness anyway.
 */
function startPolling(intervalSeconds: number): void {
  stopPolling();
  pollSeconds = Math.max(MIN_BACKGROUND_POLL_SECONDS, Math.floor(intervalSeconds));
  pollTimer = setInterval(fireTick, pollSeconds * 1000);
}

/** The interval the ticker is running at, in seconds; 0 when stopped. For tests. */
export function webPollSeconds(): number {
  return pollSeconds;
}

export const webPlatform: WebPlatform = {
  async info() {
    return WEB_INFO;
  },

  tokenStore(): TokenStore {
    return webTokenStore();
  },

  credentialStore(): CredentialStore {
    return localStorageCredentialStore();
  },

  async beginSignIn(request: SignInRequest): Promise<SignInResult> {
    // The verifier is stashed by the session; the state is recorded here so the
    // sign-in screen can show that something is in flight across the reload.
    try {
      const state = new URL(request.authorizeUrl).searchParams.get("state");
      if (state) globalThis.sessionStorage?.setItem(PENDING_STATE_KEY, state);
    } catch {
      // Ignore URL parsing errors; sign-in flow will proceed without persisted state if necessary
    }

    const location = globalThis.location;
    if (!location) {
      return { kind: "unavailable", detail: "there is no browser to navigate to Google" };
    }

    // `location.assign` rather than `window.open`: a popup is blocked unless it is
    // opened synchronously from a user gesture, and this is awaited.
    try {
      location.assign(request.authorizeUrl);
    } catch (error) {
      return {
        kind: "unavailable",
        detail: error instanceof Error ? error.message : "the browser refused to navigate",
      };
    }

    return new Promise<SignInResult>(() => {});
  },

  async cancelSignIn() {
    try {
      globalThis.sessionStorage?.removeItem(PENDING_STATE_KEY);
    } catch {
      // Ignore storage errors
    }
  },

  readRedirectFromLocation(): OAuthRedirect | null {
    const search = globalThis.location?.search;
    if (!search) return null;
    try {
      return parseRedirect(search);
    } catch {
      return null;
    }
  },

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
    if (NotificationCtor.permission === "default") {
      await NotificationCtor.requestPermission();
      return;
    }
    if (NotificationCtor.permission !== "granted") return;
    // A browser notification can carry no buttons without a service worker, which
    // Winnow does not have, so each one is click-to-open: the closure holds the id,
    // and the tab is alive to act on it. A tag per message keeps a re-sync from
    // doubling one up; the summary has its own and collapses a burst.
    for (const message of mail.messages) {
      const notification = new NotificationCtor(message.title, {
        body: mail.hidePreview ? "New message" : message.subject,
        tag: `winnow-${message.gmailId}`,
      });
      notification.onclick = () => {
        notification.close();
        emitNotificationAction({ action: "open", messageId: message.messageId, gmailId: message.gmailId, origin: "web" });
      };
    }
    if (mail.total > mail.messages.length) {
      const summary = new NotificationCtor(mail.summaryTitle, {
        body: mail.hidePreview ? "" : mail.summaryBody,
        tag: "winnow-new-mail",
      });
      summary.onclick = () => {
        summary.close();
        globalThis.focus?.();
      };
    }
  },

  onNotificationAction(handler: (event: NotificationActionEvent) => void): () => void {
    notificationHandlers.add(handler);
    return () => notificationHandlers.delete(handler);
  },

  async requestNotificationPermission(): Promise<boolean> {
    const NotificationCtor = globalThis.Notification;
    if (!NotificationCtor) return false;
    if (NotificationCtor.permission === "granted") return true;
    return (await NotificationCtor.requestPermission()) === "granted";
  },

  async setUnreadBadge(count: number): Promise<void> {
    if (typeof document === "undefined") return;
    document.title = count > 0 ? `(${count}) Winnow` : "Winnow";
  },

  async setBackgroundSync(intervalSeconds: number | null): Promise<void> {
    if (intervalSeconds === null || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      stopPolling();
      return;
    }
    startPolling(intervalSeconds);
  },

  onBackgroundTick(handler: (tick: number) => void): () => void {
    tickHandlers.add(handler);
    return () => {
      tickHandlers.delete(handler);
    };
  },

  async openExternal(url: string): Promise<void> {
    globalThis.open?.(url, "_blank", "noopener,noreferrer");
  },

  async saveFile(filename: string, bytes: Uint8Array, mimeType: string): Promise<string | null> {
    const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 0);
    return null;
  },

  async openFile(filename: string, bytes: Uint8Array, mimeType: string): Promise<boolean> {
    // A new tab on a blob URL: the browser's own viewer for a PDF. The URL outlives this
    // call because the tab loads it after the click; a minute is ample.
    const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.title = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
    return true;
  },

  async focusWindow(): Promise<void> {
    globalThis.focus?.();
  },
};

/** Who hears a browser notification's click. Module state: the tab is the only listener. */
const notificationHandlers = new Set<(event: NotificationActionEvent) => void>();

function emitNotificationAction(event: NotificationActionEvent): void {
  for (const handler of notificationHandlers) handler(event);
}

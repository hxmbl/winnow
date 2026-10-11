/**
 * Browser platform.
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
  type SignInResult,
} from "./types";

const PENDING_STATE_KEY = "winnow.pendingState";
const MIN_VISIBLE_POLL_SECONDS = 60;

const WEB_INFO: PlatformInfo = {
  name: "Winnow",
  version: "0.1.0",
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

function visibleNow(): boolean {
  return globalThis.document?.visibilityState !== "hidden";
}

function startPolling(intervalSeconds: number): void {
  stopPolling();
  pollSeconds = Math.max(MIN_VISIBLE_POLL_SECONDS, Math.floor(intervalSeconds));

  globalThis.document?.addEventListener("visibilitychange", onVisibilityChange);
  if (visibleNow()) pollTimer = setInterval(fireTick, pollSeconds * 1000);
}

function onVisibilityChange(): void {
  if (pollSeconds === 0) return;
  if (visibleNow()) {
    if (pollTimer === null) pollTimer = setInterval(fireTick, pollSeconds * 1000);
  } else {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
  }
}

export const webPlatform: WebPlatform = {
  async info() {
    return WEB_INFO;
  },

  tokenStore(): TokenStore {
    return webTokenStore();
  },

  oauthClientSecret(): string | undefined {
    if (!webRedirectUriFromEnv()) return undefined;
    return clientSecretFromEnv();
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
    if (NotificationCtor.permission === "granted") {
      const notification = new NotificationCtor(mail.title, {
        body: mail.body,
        // The tag collapses a burst into one notification. Without it, forty
        // messages arriving together produce forty toasts and the user dismisses
        // all of them without reading any.
        tag: "winnow-new-mail",
      });
      // A click on a browser notification cannot focus an existing tab, so the
      // best available behaviour is to bring this one forward. Opening the right
      // message is not possible here: `Notification` gives JS no way to carry a
      // payload through to the click handler, which is why the desktop build's
      // native notification carries message ids and this one does not.
      notification.onclick = () => {
        globalThis.focus?.();
        globalThis.location?.assign("/");
      };
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

  async setUnreadBadge(count: number): Promise<void> {
    if (typeof document === "undefined") return;
    document.title = count > 0 ? `(${count}) Winnow` : "Winnow";
  },

  async setBackgroundSync(intervalSeconds: number | null): Promise<void> {
    if (intervalSeconds === null) {
      stopPolling();
      globalThis.document?.removeEventListener("visibilitychange", onVisibilityChange);
      return;
    }
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      stopPolling();
      globalThis.document?.removeEventListener("visibilitychange", onVisibilityChange);
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

  async focusWindow(): Promise<void> {
    globalThis.focus?.();
  },
};

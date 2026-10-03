/**
 * The browser platform.
 *
 * Every method here has a real, working browser implementation. That is the point
 * of the boundary: the web build is not a degraded desktop build, it is a complete
 * Winnow that lacks five OS conveniences — and the UI knows which five, because
 * `info()` says so.
 *
 * Three of those five were *pretended* rather than absent, and that is worse:
 *
 *   - `setBackgroundSync` resolved and did nothing, on the strength of a comment
 *     claiming "the store's own timer covers the open case". There was no such
 *     timer anywhere in the app — no `setInterval` existed in `src/` at all — so
 *     a signed-in browser user never saw new mail unless they pressed Sync. Since
 *     the notification toggle reads as enabled and fires only from a refresh, that
 *     toggle could not do anything either. There is a real timer here now, and it
 *     lives here because visibility is a platform question.
 *   - `beginSignIn` returned `{ kind: "cancelled" }` immediately after calling
 *     `location.assign`, on a promise the session layer was awaiting. It worked by
 *     accident: the page is torn down before the value is read. The web flow is
 *     now stated honestly — it navigates and does not resolve — and the session
 *     reads the result from the URL on the way back.
 *   - `saveFile` still has no dialog, and cannot. That one is a real limitation
 *     rather than a missing implementation, and it says so.
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

/**
 * Where the in-flight `state` is kept.
 *
 * `sessionStorage` rather than a module variable: the page is destroyed and
 * rebuilt by the redirect, so anything held in a local is gone by the time
 * anyone asks "is a sign-in still pending?".
 */
const PENDING_STATE_KEY = "winnow.pendingState";

/**
 * How often the foreground poll runs, and the floor beneath the user's choice.
 *
 * The default matches the store's preference. The floor is Google's rate-limit
 * reality rather than a politeness gesture: a tab that polls every ten seconds
 * gets itself throttled, and a throttled tab stops syncing altogether, so a fast
 * setting would make the app *less* reliable than a slow one.
 */
const MIN_VISIBLE_POLL_SECONDS = 60;

const WEB_INFO: PlatformInfo = {
  name: "Winnow",
  version: "0.1.0",
  os: "browser",
  arch: "unknown",
  kind: "web",
  nativeOAuth: false,
  nativeSecrets: false,
  // Honest now: the browser build really does poll, on a timer that stops when
  // the tab is hidden. Claiming `false` here is what let a browser build and a
  // desktop build disagree about a capability they both have.
  backgroundSync: true,
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

/**
 * The foreground poll.
 *
 * Module-level, because the platform object is a module-level singleton and there
 * is exactly one of it. Held in one place so `setBackgroundSync(null)` and the
 * visibility listener cannot leave two timers running.
 */
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

/**
 * Poll only while the page is in front of the user.
 *
 * The `visibilitychange` listener is the load-bearing part. A hidden tab's timers
 * are throttled to roughly one per minute by every browser, so a timer left
 * running in the background spends the user's rate-limit quota on polls that
 * mostly cannot succeed — and Chrome's intensive throttling takes it to once a
 * minute *or slower*. Pausing on hide is what makes the foreground interval mean
 * what it says.
 */
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
   * Sign in by navigating away.
   *
   * This promise is never resolved in a real browser, and saying so is the honest
   * shape of the web flow: there is no continuation to resume, because the page
   * and every local in it are destroyed. `session.completeWebRedirect` reads the
   * result out of the URL on the way back.
   *
   * The `cancelled` return exists only so the shared `Platform` type has one shape
   * for both hosts. It is reached if a browser ever *refused* the navigation —
   * a blocked redirect, a sandboxed frame — which is a cancellation rather than a
   * hang, so surfacing it beats waiting forever for a page load that will not
   * happen.
   */
  async beginSignIn(request: SignInRequest): Promise<SignInResult> {
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
    // `location.assign` rather than `window.open`: a popup is blocked unless it is
    // opened synchronously from a user gesture, and this is awaited.
    globalThis.location?.assign(request.authorizeUrl);
    return { kind: "cancelled" };
  },

  async cancelSignIn() {
    // The web flow's sign-in is a navigation the browser controls; nothing to abort
    // from here. What can be cleared is our own record of it, and the half-finished
    // verifier in `sessionStorage`, which `sessionStorage`'s own lifecycle will
    // discard when the tab closes.
    try {
      globalThis.sessionStorage?.removeItem(PENDING_STATE_KEY);
    } catch {
      // Already unreachable; nothing to clear.
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

  async setBackgroundSync(intervalSeconds: number | null): Promise<void> {
    if (intervalSeconds === null) {
      stopPolling();
      globalThis.document?.removeEventListener("visibilitychange", onVisibilityChange);
      return;
    }
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      // A zero or NaN interval from a corrupted preference would otherwise become
      // `setInterval(fn, NaN)`, which fires continuously and hammers the API.
      stopPolling();
      globalThis.document?.removeEventListener("visibilitychange", onVisibilityChange);
      return;
    }
    startPolling(intervalSeconds);
  },

  /**
   * Subscribe to the foreground poll.
   *
   * A `Set` rather than a single handler, because the store and any future
   * consumer both want the tick, and a second subscriber silently replacing the
   * first is a bug waiting for a second caller. Each call returns its own
   * unsubscribe.
   */
  onBackgroundTick(handler: (tick: number) => void): () => void {
    tickHandlers.add(handler);
    return () => {
      tickHandlers.delete(handler);
    };
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

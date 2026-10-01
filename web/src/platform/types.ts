/**
 * The platform boundary.
 *
 * This is the only place Winnow asks "am I in a browser or on the desktop?",
 * and it is deliberately a small interface with a boring implementation for
 * each side. The rule for what belongs here:
 *
 * > If a browser can do it, it does not belong in this interface.
 *
 * Everything in `core/` is pure TypeScript and runs unchanged in both. What
 * remains here is the list of things a browser genuinely cannot do well:
 *
 * | Capability | Browser | Desktop |
 * | --- | --- | --- |
 * | Secrets at rest | `localStorage` | OS keychain (Rust command) |
 * | OAuth redirect | a page load back to the site | loopback listener (Rust) |
 * | Background sync while hidden | a timer, throttled hard | a Rust thread |
 * | Notification | `Notification` | native, with message ids |
 * | Unread badge | `document.title` | dock badge / tray tooltip |
 * | Save an attachment | a download | a real save dialog, returns a path |
 * | Open a link | a new tab | the system browser |
 *
 * `PLATFORM_KEYS` is the test that keeps this honest: every feature flag in
 * `core/` is checked against it, so a capability cannot be claimed in the app
 * that the desktop shell does not actually provide.
 */

import type { TokenSet } from "../core/gmail/dto";
import type { TokenStore } from "../core/gmail/tokens";

/** What this build can do. Reported to the UI so it can hide what is absent. */
export type PlatformInfo = {
  name: string;
  version: string;
  os: string;
  arch: string;
  kind: "web" | "desktop";
  /** OAuth is delivered by a loopback listener rather than a page redirect. */
  nativeOAuth: boolean;
  /** Secrets go to the OS keychain rather than to `localStorage`. */
  nativeSecrets: boolean;
  /** A background thread can tick while the window is hidden. */
  backgroundSync: boolean;
  /** The OS can be asked where to put a file. */
  saveFiles: boolean;
};

export type NewMailNotification = {
  title: string;
  body: string;
  /** So a click can open the right conversation, not whatever is selected. */
  messageIds: number[];
};

/** An OAuth attempt that the platform delivered back to us. */
export type OAuthRedirect =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; error: string; description: string; state: string }
  | { kind: "cancelled" };

export type SignInRequest = {
  /** The fully-formed Google authorize URL, PKCE challenge included. */
  authorizeUrl: string;
  /** How long to wait for the user to finish in the browser. */
  timeoutMs: number;
};

export interface Platform {
  info(): Promise<PlatformInfo>;

  // ── Secrets ──────────────────────────────────────────────────────────────

  /** A `TokenStore` backed by the keychain, or by `localStorage`. */
  tokenStore(): TokenStore;

  /**
   * The OAuth client secret this build should send at the token exchange.
   *
   * This is a *platform* decision, not a session one, because it follows from
   * how Google's OAuth taxonomy classifies the client, and the classification is
   * a property of where the code runs:
   *
   *   - **Desktop** — an "installed app" client. There is nowhere to keep a
   *     secret, and shipping one would publish it. PKCE is the whole security
   *     story, so this returns `undefined` and must keep returning `undefined`.
   *   - **Web** — a "web application" client. Google rejects the token exchange
   *     for this client type unless the secret accompanies it, so a developer who
   *     registered one has to have it used. It is public in the bundle by
   *     construction; PKCE is still doing the real work, since the secret alone
   *     does not let anyone exchange a code they do not hold the verifier for.
   *
   * A web build with no secret configured returns `undefined` too, and the token
   * exchange fails with a message naming the missing variable rather than
   * Google's `invalid_client` string.
   */
  oauthClientSecret(): string | undefined;

  // ── Sign-in ──────────────────────────────────────────────────────────────

  /**
   * Send the user to `authorizeUrl` and wait for the redirect.
   *
   * The desktop build opens the system browser and listens on a loopback port;
   * the web build navigates and reads the result from the URL. Both return the
   * same shape, so the store's sign-in path has no branch.
   */
  beginSignIn(request: SignInRequest): Promise<OAuthRedirect>;

  /** Abandon an in-flight sign-in. */
  cancelSignIn(): Promise<void>;

  // ── OS integration ───────────────────────────────────────────────────────

  notifyNewMail(mail: NewMailNotification): Promise<void>;

  /** Whether notifications are permitted, so the UI can explain a refusal. */
  requestNotificationPermission(): Promise<boolean>;

  /** Show an unread count on the dock, tray, or the document title. */
  setUnreadBadge(count: number): Promise<void>;

  /**
   * Ask the OS to tick `intervalSeconds` while the app is hidden.
   *
   * `null` parks it. The browser implementation resolves immediately and does
   * nothing: a hidden tab is throttled to the point where polling it is worse
   * than not polling, and a page that is not open cannot run at all.
   */
  setBackgroundSync(intervalSeconds: number | null): Promise<void>;

  /** Called on each background tick. Returns a no-op unsubscribe. */
  onBackgroundTick(handler: (tick: number) => void): () => void;

  /** Open a URL in the system browser rather than inside the app. */
  openExternal(url: string): Promise<void>;

  /**
   * Save bytes to a file.
   *
   * Returns the path on the desktop, or `null` where the user dismissed the
   * dialog. In a browser there is no dialog, so the platform layer turns this
   * into a download and resolves `null`.
   */
  saveFile(filename: string, bytes: Uint8Array, mimeType: string): Promise<string | null>;

  /** Bring the window to the front, for a deep link that arrived while hidden. */
  focusWindow(): Promise<void>;
}

/**
 * The capabilities a build is expected to have.
 *
 * Used by the app's own tests: if a feature needs a capability, it declares it
 * here, and a build that cannot provide it has to fail a test rather than
 * silently degrade at runtime.
 */
export const PLATFORM_KEYS = [
  "nativeOAuth",
  "nativeSecrets",
  "backgroundSync",
  "saveFiles",
] as const;

export type PlatformKey = (typeof PLATFORM_KEYS)[number];

/** A `TokenStore` for browsers, where the keychain is not available. */
export function webTokenStore(key = "winnow.gmail.tokens"): TokenStore {
  return {
    async read(): Promise<TokenSet | null> {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as TokenSet;
        return parsed?.accessToken ? parsed : null;
      } catch {
        // Private-mode Safari and a full quota both throw here. Neither is
        // worth failing sign-in over; the user simply is not signed in.
        return null;
      }
    },
    async write(tokens: TokenSet): Promise<void> {
      globalThis.localStorage?.setItem(key, JSON.stringify(tokens));
    },
    async clear(): Promise<void> {
      globalThis.localStorage?.removeItem(key);
    },
  };
}

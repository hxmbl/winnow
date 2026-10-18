/**
 * Platform boundary.
 */

import type { TokenStore } from "../core/gmail/tokens";
import type { CredentialStore } from "../core/session/credentials";

/** What this build can do. Reported to the UI so it can hide what is absent. */
export type PlatformInfo = {
  name: string;
  version: string;
  os: string;
  arch: string;
  kind: "web" | "desktop";
  nativeOAuth: boolean;
  nativeSecrets: boolean;
  backgroundSync: boolean;
  saveFiles: boolean;
};

export type NewMailNotification = {
  title: string;
  body: string;
  messageIds: number[];
};

/** An OAuth attempt that the platform delivered back to us. */
export type OAuthRedirect =
  | {
      kind: "code";
      code: string;
      state: string;
      redirectUri?: string;
    }
  | { kind: "error"; error: string; description: string; state: string }
  | { kind: "cancelled" };

export type SignInRequest = {
  authorizeUrl: string;
  timeoutMs: number;
};

export type SignInFailure =
  | { kind: "cancelled" }
  | { kind: "timeout" }
  | { kind: "unavailable"; detail: string };

/** What `beginSignIn` can hand back when there is no authorization code. */
export type SignInResult = OAuthRedirect | SignInFailure;

export interface Platform {
  info(): Promise<PlatformInfo>;

  // ── Secrets ──────────────────────────────────────────────────────────────

  /** A `TokenStore` backed by the keychain, or by `localStorage`. */
  tokenStore(): TokenStore;

  /**
   * Where the user's own Google OAuth client (id, and secret when there is one) lives:
   * the keychain on the desktop, `localStorage` in the browser. Never sent anywhere but
   * Google.
   */
  credentialStore(): CredentialStore;

  // ── Sign-in ──────────────────────────────────────────────────────────────

  beginSignIn(request: SignInRequest): Promise<SignInResult>;

  cancelSignIn(): Promise<void>;

  /**
   * Resolve once the app is back in the foreground, or the platform stops waiting.
   *
   * Called before each authorization-code exchange. Only Android needs it: its
   * WebView is paused behind the browser when the redirect arrives, and a request
   * made then fails without reaching Google. Optional; absent means "go now".
   */
  waitForForeground?(): Promise<unknown>;

  // ── OS integration ───────────────────────────────────────────────────────

  notifyNewMail(mail: NewMailNotification): Promise<void>;

  requestNotificationPermission(): Promise<boolean>;
  setUnreadBadge(count: number): Promise<void>;
  setBackgroundSync(intervalSeconds: number | null): Promise<void>;

  onBackgroundTick(handler: (tick: number) => void): () => void;
  openExternal(url: string): Promise<void>;
  saveFile(filename: string, bytes: Uint8Array, mimeType: string): Promise<string | null>;
  /**
   * Show a file (a PDF attachment) in a viewer: the browser's own in a new tab, or the
   * system's default app on the desktop. `false` when this host cannot, and the caller
   * saves it instead (Android). Optional so a test double need not implement it.
   */
  openFile?(filename: string, bytes: Uint8Array, mimeType: string): Promise<boolean>;
  focusWindow(): Promise<void>;
}

export const PLATFORM_KEYS = [
  "nativeOAuth",
  "nativeSecrets",
  "backgroundSync",
  "saveFiles",
] as const;

export type PlatformKey = (typeof PLATFORM_KEYS)[number];

export { localStorageTokenStore as webTokenStore } from "../core/gmail/tokens";

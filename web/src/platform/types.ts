/**
 * Platform boundary.
 */

import type { TokenStore } from "../core/gmail/tokens";
import type { CredentialStore } from "../core/session/credentials";
import type { NotificationActionEvent, NotificationBatch } from "../core/notify/notifications";

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

/**
 * One sync's new mail, as the platform shows it: a notification per message (at most
 * five) with the buttons the user allowed, and a summary. See `core/notify/notifications.ts`.
 */
export type NewMailNotification = NotificationBatch;

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

/** A native Android sign-in: Google Play services' account sheet, no browser. */
export type NativeSignInRequest = {
  /** The Web application client the code is issued to. */
  serverClientId: string;
  /** Every scope the session should end up with. */
  scopes: string[];
};

/**
 * Why a native sign-in did not produce a code. Every one of these ends in the browser
 * flow; only `cancelled` (the user closed the sheet) stops the sign-in.
 *
 * - `unsupported`: not Android, or a build without the plugin.
 * - `no_play_services`: Google Play services is missing, disabled or too old.
 * - `developer_error`: Google refused the app — no Android client in the
 *   `serverClientId`'s project matches this package name and signing certificate.
 * - `network`: Play services could not reach Google.
 * - `failed`: anything else, including a code Google did not hand back.
 */
export type NativeUnavailableReason =
  | "unsupported"
  | "no_play_services"
  | "developer_error"
  | "network"
  | "failed";

export type NativeSignInResult =
  | { kind: "code"; code: string; grantedScopes: string[] }
  | { kind: "cancelled" }
  | { kind: "unavailable"; reason: NativeUnavailableReason; detail: string };

/** What the setup guide shows for registering an Android client. Read at run time. */
export type AppSigningInfo = {
  packageName: string;
  /** The running APK's signing certificate, `AA:BB:…`, or `null` when unreadable. */
  sha1: string | null;
  /** Whether Google Play services is usable on this phone. */
  playServices: boolean;
};

export interface Platform {
  info(): Promise<PlatformInfo>;

  // ── Secrets ──────────────────────────────────────────────────────────────

  /**
   * A `TokenStore` backed by the keychain, or by `localStorage`. With `account` (1.4.0),
   * that account's own entry: keychain `gmail.tokens@<id>` under the same service, or
   * `winnow.gmail.tokens@<id>`. Without it, 1.3.5's single entry, which only the
   * migration still reads.
   */
  tokenStore(account?: string): TokenStore;

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

  /**
   * Android only, optional: sign in through Google Play services instead of the
   * browser. Never throws; anything but a code or a cancel is `unavailable`, and the
   * session falls back to `beginSignIn`.
   */
  nativeGoogleSignIn?(request: NativeSignInRequest): Promise<NativeSignInResult>;

  /** Android only, optional: the package name and signing certificate, for setup. */
  appSigningInfo?(): Promise<AppSigningInfo | null>;

  // ── OS integration ───────────────────────────────────────────────────────

  notifyNewMail(mail: NewMailNotification): Promise<void>;

  /**
   * A press on one of those notifications: its body (`open`) or a button. Desktop and
   * browser presses are for the app to carry out; Android's arrive already carried out
   * (`origin: "android"`). Returns the unsubscribe.
   */
  onNotificationAction(handler: (event: NotificationActionEvent) => void): () => void;

  /** Desktop: say on the notification what the app did with a press. Optional. */
  confirmNotificationAction?(messageId: number, title: string, text: string, failed: boolean): Promise<void>;

  /**
   * Android: replies typed into a notification that could not be sent or saved, for the
   * app to save to Drafts. Listing keeps them; `releaseKeptReplies` forgets the ones
   * saved. Optional; absent means none.
   */
  keptReplies?(): Promise<unknown[]>;
  releaseKeptReplies?(requestIds: readonly string[]): Promise<void>;

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

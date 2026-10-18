/**
 * Tauri platform.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { exit, onBackButtonPress } from "@tauri-apps/api/app";
import type { TokenSet } from "../core/gmail/dto";
import type { TokenStore } from "../core/gmail/tokens";
import {
  KEYCHAIN_CREDENTIALS_NAME,
  normaliseCredentials,
  parseStoredCredentials,
  type CredentialStore,
} from "../core/session/credentials";
import type {
  AppSigningInfo,
  NativeSignInRequest,
  NativeSignInResult,
  NewMailNotification,
  Platform,
  PlatformInfo,
  SignInRequest,
  SignInResult,
} from "./types";
import { parseNativeSignInResult, parseSigningInfo, unavailable } from "./nativeGoogle";
import { waitUntilVisible } from "./visibility";
import { parseNotificationAction, type NotificationActionEvent } from "../core/notify/notifications";

/** Events from Rust. */
const SYNC_TICK_EVENT = "winnow://sync-tick";
const DEEP_LINK_EVENT = "winnow://open-url";
const TRAY_ACTION_EVENT = "winnow://tray-action";
/** `notify_actions::ACTION_EVENT`. */
const NOTIFICATION_ACTION_EVENT = "winnow://notification-action";

type AuthOutcome =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; error: string; description: string; state: string };

let activePort: number | null = null;
const TIMED_OUT = /\btimed?[\s-]?out\b/i;
const ABANDONED = /\b(cancel|abort|close|disconnect|drop|abandon)\w*\b/i;

async function abandonSignIn(port: number): Promise<void> {
  if (activePort === port) activePort = null;
  await invoke("oauth_cancel", { port }).catch(() => undefined);
}

const keychainTokenStore = (name = "gmail.tokens"): TokenStore => ({
  async read(): Promise<TokenSet | null> {
    const raw = await invoke<string | null>("secrets_get", { name });
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as TokenSet;
      return parsed?.accessToken ? parsed : null;
    } catch {
      return null;
    }
  },
  async write(tokens: TokenSet): Promise<void> {
    await invoke("secrets_set", { name, value: JSON.stringify(tokens) });
  },
  async clear(): Promise<void> {
    await invoke("secrets_delete", { name });
  },
});

/**
 * The user's OAuth client, in the OS keychain next to the tokens.
 *
 * The same `secrets_*` commands, under its own entry name, so removing it never touches
 * the token entry and vice versa.
 */
const keychainCredentialStore = (name = KEYCHAIN_CREDENTIALS_NAME): CredentialStore => ({
  async read() {
    const raw = await invoke<string | null>("secrets_get", { name });
    return parseStoredCredentials(raw);
  },
  async write(credentials) {
    await invoke("secrets_set", { name, value: JSON.stringify(normaliseCredentials(credentials)) });
  },
  async clear() {
    await invoke("secrets_delete", { name });
  },
});

/** Cached app info. */
let infoPromise: Promise<PlatformInfo> | null = null;

export const desktopPlatform: Platform = {
  info(): Promise<PlatformInfo> {
    infoPromise ??= invoke<Record<string, unknown>>("app_info")
      .then(normaliseAppInfo)
      .catch((error) => {
        infoPromise = null;
        throw error;
      });
    return infoPromise;
  },

  tokenStore(): TokenStore {
    return keychainTokenStore();
  },

  credentialStore(): CredentialStore {
    return keychainCredentialStore();
  },

  async beginSignIn(request: SignInRequest): Promise<SignInResult> {
    const begun = await invoke<{ port: number; authorize_url: string }>("oauth_begin", {
      authorizeUrl: request.authorizeUrl,
    });
    activePort = begun.port;

    try {
      await openSignInPage(begun.authorize_url, androidWebView());
    } catch (error) {
      await abandonSignIn(begun.port);
      return {
        kind: "unavailable",
        detail: describeIpcError(error, "the browser could not be opened"),
      };
    }

    try {
      const outcome = await invoke<AuthOutcome>("oauth_await", {
        port: begun.port,
        timeoutMs: request.timeoutMs,
      });
      if (outcome.kind !== "code") return outcome;
      const redirectUri = redirectUriIn(begun.authorize_url);
      return redirectUri ? { ...outcome, redirectUri } : outcome;
    } catch (error) {
      const message = describeIpcError(error, "the sign-in listener stopped");
      if (TIMED_OUT.test(message)) return { kind: "timeout" };
      if (ABANDONED.test(message)) return { kind: "cancelled" };
      return { kind: "unavailable", detail: message };
    } finally {
      activePort = null;
    }
  },

  async cancelSignIn(): Promise<void> {
    if (activePort === null) return;
    await abandonSignIn(activePort);
  },

  async nativeGoogleSignIn(request: NativeSignInRequest): Promise<NativeSignInResult> {
    if (!(await isAndroid())) return unavailable("unsupported", "native sign-in is Android only");
    try {
      const raw = await invoke<unknown>("google_signin_authorize", {
        serverClientId: request.serverClientId,
        scopes: request.scopes,
      });
      return parseNativeSignInResult(raw);
    } catch (error) {
      return unavailable("failed", describeIpcError(error, "the sign-in plugin did not answer"));
    }
  },

  async appSigningInfo(): Promise<AppSigningInfo | null> {
    if (!(await isAndroid())) return null;
    try {
      return parseSigningInfo(await invoke<unknown>("google_signin_info"));
    } catch {
      return null;
    }
  },

  async waitForForeground(): Promise<unknown> {
    // Desktop webviews are not paused behind the browser, and a minimised window can
    // report "hidden" for as long as it stays minimised, so waiting there would only
    // hold the sign-in up. Android is the platform that pauses.
    const { os } = await this.info().catch(() => ({ os: "unknown" }));
    if (os !== "android") return true;
    return waitUntilVisible();
  },

  async notifyNewMail(mail: NewMailNotification): Promise<void> {
    // `notify_messages` (Rust, `notify_actions/`): per-message notifications with
    // buttons on Android, Linux and Windows; one grouped notification on macOS.
    await invoke("notify_messages", { batch: mail });
  },

  onNotificationAction(handler: (event: NotificationActionEvent) => void): () => void {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<unknown>(NOTIFICATION_ACTION_EVENT, (event) => {
      const parsed = parseNotificationAction(event.payload);
      if (parsed) handler(parsed);
    })
      .then((fn) => (cancelled ? fn() : (unlisten = fn)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },

  async confirmNotificationAction(messageId: number, title: string, text: string, failed: boolean): Promise<void> {
    await invoke("notify_action_result", { result: { messageId, title, text, failed } }).catch(() => undefined);
  },

  async keptReplies(): Promise<unknown[]> {
    return invoke<unknown[]>("notify_kept_replies").catch(() => []);
  },

  async releaseKeptReplies(requestIds: readonly string[]): Promise<void> {
    await invoke("notify_release_kept", { ids: [...requestIds] });
  },

  async requestNotificationPermission(): Promise<boolean> {
    return invoke<boolean>("request_notification_permission");
  },

  async setUnreadBadge(count: number): Promise<void> {
    await invoke("set_unread_badge", { count });
  },

  async setBackgroundSync(intervalSeconds: number | null): Promise<void> {
    await invoke("set_background_sync", { intervalSecs: intervalSeconds });
  },

  onBackgroundTick(handler: (tick: number) => void): () => void {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void listen<number>(SYNC_TICK_EVENT, (event) => {
      handler(event.payload);
    })
      .then((fn) => {
        // The app may have unsubscribed before `listen` resolved.
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  },

  async openExternal(url: string): Promise<void> {
    await invoke("open_external", { url });
  },

  async saveFile(
    filename: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<string | null> {
    void mimeType;
    const base64 = bytesToBase64(bytes);
    return invoke<string | null>("save_attachment", { filename, bytesBase64: base64 });
  },

  async openFile(filename: string, bytes: Uint8Array, mimeType: string): Promise<boolean> {
    void mimeType;
    // Android has no "open with the default app" for a file Winnow writes; the caller
    // saves it through the system picker instead.
    if ((await this.info()).os === "android") return false;
    await invoke<null>("open_attachment", { filename, bytesBase64: bytesToBase64(bytes) });
    return true;
  },

  async focusWindow(): Promise<void> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    await window.unminimize().catch(() => undefined);
    await window.show().catch(() => undefined);
    await window.setFocus().catch(() => undefined);
  },
};

export const desktopPlatformExtras = {
  onDeepLink(handler: (url: string) => void): () => void {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<string>(DEEP_LINK_EVENT, (event) => handler(event.payload))
      .then((fn) => (cancelled ? fn() : (unlisten = fn)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },

  /**
   * Android's Back button, while `handler` is registered (`onBackButtonPress`).
   *
   * Registering takes the press over entirely — the webview no longer goes back or
   * leaves the app on its own — so the app registers only while it has a layer to
   * close, and the returned function hands Back to Android again at the root list. A
   * no-op everywhere but Android, where the event never fires.
   */
  onBackButton(handler: () => void): () => void {
    let cancelled = false;
    let unregister: (() => void) | null = null;
    void onBackButtonPress(() => handler())
      .then((listener) => {
        const stop = () => void listener.unregister().catch(() => undefined);
        if (cancelled) stop();
        else unregister = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unregister?.();
    };
  },

  /** Leave the app (Android's Back at the root, when the press reached the app anyway). */
  async exitApp(): Promise<void> {
    await exit(0).catch(() => undefined);
  },

  onTrayAction(handler: (action: string) => void): () => void {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<string>(TRAY_ACTION_EVENT, (event) => handler(event.payload))
      .then((fn) => (cancelled ? fn() : (unlisten = fn)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },
};

/**
 * Whether this webview is Android's, from its user agent: synchronous and without an IPC
 * round trip, for the one place that only picks how to open a page. Anything that
 * decides more than that asks `app_info` (`isAndroid`).
 */
function androidWebView(): boolean {
  return /\bAndroid\b/.test(globalThis.navigator?.userAgent ?? "");
}

async function isAndroid(): Promise<boolean> {
  const { os } = await desktopPlatform.info().catch(() => ({ os: "unknown" }));
  return os === "android";
}

/**
 * Open Google's consent page for a loopback sign-in.
 *
 * On Android, in a Custom Tab (`open_sign_in_tab`): it opens over the app, in the
 * app's own task, so the success page's "Back to Winnow" link closes it rather than
 * leaving a browser tab behind. A phone with no Custom Tabs browser still gets a plain
 * browser from the same call; if the command itself fails, the system browser
 * (`open_external`) is the fallback, which is how every sign-in opened before.
 */
export async function openSignInPage(
  url: string,
  android: boolean,
  call: (command: string, args: Record<string, unknown>) => Promise<unknown> = invoke,
): Promise<void> {
  if (android) {
    try {
      await call("open_sign_in_tab", { url });
      return;
    } catch {
      // Fall through to the system browser.
    }
  }
  await call("open_external", { url });
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

type AppInfoWire = {
  name: string;
  version: string;
  os: string;
  arch: string;
  kind: "web" | "desktop";
  nativeOAuth: boolean;
  nativeSecrets: boolean;
  backgroundSync: boolean;
  saveFiles: boolean;
  native_oauth?: boolean;
  native_secrets?: boolean;
  background_sync?: boolean;
  save_files?: boolean;
};

function normaliseAppInfo(wire: Record<string, unknown>): PlatformInfo {
  const source = wire as Partial<AppInfoWire> & Record<string, unknown>;
  const flag = (camel: keyof AppInfoWire, snake: keyof AppInfoWire): boolean =>
    source[camel] === true || source[snake] === true;

  return {
    name: typeof source.name === "string" ? source.name : "Winnow",
    version: typeof source.version === "string" ? source.version : "0.0.0",
    os: typeof source.os === "string" ? source.os : "unknown",
    arch: typeof source.arch === "string" ? source.arch : "unknown",
    kind: source.kind === "desktop" ? "desktop" : "web",
    nativeOAuth: flag("nativeOAuth", "native_oauth"),
    nativeSecrets: flag("nativeSecrets", "native_secrets"),
    backgroundSync: flag("backgroundSync", "background_sync"),
    saveFiles: flag("saveFiles", "save_files"),
  };
}

function describeIpcError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = message.trim().replace(/\s+/g, " ");
  if (!cleaned) return fallback;
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

function redirectUriIn(authorizeUrl: string): string | undefined {
  try {
    return new URL(authorizeUrl).searchParams.get("redirect_uri") ?? undefined;
  } catch {
    return undefined;
  }
}

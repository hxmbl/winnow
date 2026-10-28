/**
 * Tauri platform.
 */

import { invoke } from "@tauri-apps/api/core";
import { reportedVersion } from "../core/updates/buildVersion";
import { listen } from "@tauri-apps/api/event";
import { exit, onBackButtonPress } from "@tauri-apps/api/app";
import type { TokenSet } from "../core/gmail/dto";
import type { TokenStore } from "../core/gmail/tokens";
import { tokenSecretName } from "../core/session/accounts";
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
import { debugLog, setNativeDebugBridge, syncNativeDebugLog } from "../core/debug/debugLog";
import { parseNotificationAction, type NotificationActionEvent } from "../core/notify/notifications";
import { parseChannel, type UpdateOffer, type UpdateRuntime } from "../core/updates/updates";
import type { ActiveNotice, BackgroundServiceConfig, BackgroundServiceStatus, InstallOutcome } from "./types";
import { parseActiveNotices, parseBackgroundStatus } from "../core/notify/backgroundService";

/** Events from Rust. */
const SYNC_TICK_EVENT = "winnow://sync-tick";
const DEEP_LINK_EVENT = "winnow://open-url";
const TRAY_ACTION_EVENT = "winnow://tray-action";
/** `notify_actions::ACTION_EVENT`. */
const NOTIFICATION_ACTION_EVENT = "winnow://notification-action";
/** `debug_log::DEBUG_LOG_EVENT`: native debug-log lines are waiting. */
const DEBUG_LOG_EVENT = "winnow://debug-log";

type AuthOutcome =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; error: string; description: string; state: string };

let activePort: number | null = null;
const TIMED_OUT = /\btimed?[\s-]?out\b/i;
const ABANDONED = /\b(cancel|abort|close|disconnect|drop|abandon)\w*\b/i;

async function abandonSignIn(port: number): Promise<void> {
  debugLog("auth", "loopback-abandon", { port });
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

  tokenStore(account?: string): TokenStore {
    return account ? keychainTokenStore(tokenSecretName(account)) : keychainTokenStore();
  },

  credentialStore(): CredentialStore {
    return keychainCredentialStore();
  },

  async beginSignIn(request: SignInRequest): Promise<SignInResult> {
    const android = androidWebView();
    debugLog("auth", "loopback-begin", { android, timeoutMs: request.timeoutMs });
    let begun: { port: number; authorize_url: string };
    try {
      begun = await invoke<{ port: number; authorize_url: string }>("oauth_begin", {
        authorizeUrl: request.authorizeUrl,
      });
    } catch (error) {
      debugLog("auth", "loopback-begin-failed", { reason: describeIpcError(error, "the listener did not start") });
      throw error;
    }
    activePort = begun.port;
    const redirect = redirectUriIn(begun.authorize_url);
    debugLog("auth", "loopback-listening", {
      port: begun.port,
      // Host and path only: the URI carries no secrets, but the log keeps to the shape.
      redirect: redirect ? redirect.replace(/^http:\/\/([^/]+)(\/[^?#]*).*$/, "$1$2") : "missing",
    });

    try {
      const opened = await openSignInPage(begun.authorize_url, android);
      debugLog("auth", "consent-page-opened", { via: opened.via, keptAlive: opened.keptAlive, keepAlive: opened.keepAlive });
    } catch (error) {
      debugLog("auth", "consent-page-failed", { reason: describeIpcError(error, "the browser could not be opened") });
      await abandonSignIn(begun.port);
      return {
        kind: "unavailable",
        detail: describeIpcError(error, "the browser could not be opened"),
      };
    }

    const started = Date.now();
    debugLog("auth", "redirect-wait-start", { port: begun.port });
    try {
      const outcome = await invoke<AuthOutcome>("oauth_await", {
        port: begun.port,
        timeoutMs: request.timeoutMs,
      });
      debugLog("auth", "redirect-wait-done", {
        outcome: outcome.kind,
        error: outcome.kind === "error" ? outcome.error : undefined,
        ms: Date.now() - started,
      });
      if (outcome.kind !== "code") return outcome;
      return redirect ? { ...outcome, redirectUri: redirect } : outcome;
    } catch (error) {
      const message = describeIpcError(error, "the sign-in listener stopped");
      const kind = TIMED_OUT.test(message) ? "timeout" : ABANDONED.test(message) ? "cancelled" : "unavailable";
      debugLog("auth", "redirect-wait-failed", { kind, reason: message, ms: Date.now() - started });
      if (kind === "timeout") return { kind: "timeout" };
      if (kind === "cancelled") return { kind: "cancelled" };
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
    // An array or nothing: a shell without the command answers `null`.
    const kept = await invoke<unknown[] | null>("notify_kept_replies").catch(() => []);
    return Array.isArray(kept) ? kept : [];
  },

  async withdrawNotifications(gmailIds: readonly string[], account?: string | null): Promise<void> {
    // `notify_withdraw`: Android cancels them and rebuilds the summary; Linux closes them
    // over D-Bus; macOS removes a batch once all of it is handled; Windows clears once none is left.
    await invoke("notify_withdraw", { gmailIds: [...gmailIds], account: account ?? null }).catch(() => undefined);
  },

  async clearNotifications(account: string | null): Promise<void> {
    await invoke("notify_clear_account", { account }).catch(() => undefined);
  },

  async activeNotifications(): Promise<ActiveNotice[]> {
    const items = await invoke<unknown>("notify_active").catch(() => []);
    return parseActiveNotices(items);
  },

  async configureBackgroundService(config: BackgroundServiceConfig): Promise<BackgroundServiceStatus | null> {
    const status = await invoke<unknown>("background_service_configure", { config });
    return parseBackgroundStatus(status);
  },

  async backgroundServiceStatus(): Promise<BackgroundServiceStatus | null> {
    return parseBackgroundStatus(await invoke<unknown>("background_service_status").catch(() => null));
  },

  async requestBatteryExemption(): Promise<BackgroundServiceStatus | null> {
    return parseBackgroundStatus(await invoke<unknown>("background_service_battery").catch(() => null));
  },

  async openSyncNotificationSettings(): Promise<void> {
    await invoke("background_service_notification_settings").catch(() => undefined);
  },

  async openNotificationAccess(): Promise<BackgroundServiceStatus | null> {
    return parseBackgroundStatus(await invoke<unknown>("background_service_listener_settings").catch(() => null));
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

  async updateRuntime(): Promise<UpdateRuntime> {
    try {
      const wire = await invoke<Record<string, unknown>>("update_runtime");
      return {
        channel: parseChannel(wire?.channel),
        version: reportedVersion(typeof wire?.version === "string" ? wire.version : "0.0.0"),
        arch: typeof wire?.arch === "string" ? wire.arch : "unknown",
      };
    } catch {
      // A shell that predates `update_runtime`: it can only point at the release page.
      const info = await desktopPlatform.info().catch(() => null);
      return { channel: "manual", version: reportedVersion(info?.version ?? "0.0.0"), arch: info?.arch ?? "unknown" };
    }
  },

  async installUpdate(offer: UpdateOffer): Promise<InstallOutcome> {
    return installUpdateWith(offer, invoke);
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
  /**
   * Connect Dev Options → Debug log to the shell's own log (`debug_log.rs`): the switch
   * reaches Rust, and Rust's lines are drained in whenever it says some are waiting. A
   * shell that predates the commands answers with errors, which are ignored.
   */
  installNativeDebugLog(): () => void {
    setNativeDebugBridge({
      setEnabled: (on) => invoke("debug_log_set_enabled", { enabled: on }),
      drain: async () => {
        const lines = await invoke<unknown>("debug_log_drain");
        return Array.isArray(lines) ? lines.filter((line): line is string => typeof line === "string") : [];
      },
    });
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen(DEBUG_LOG_EVENT, () => void syncNativeDebugLog())
      .then((fn) => (cancelled ? fn() : (unlisten = fn)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
      setNativeDebugBridge(null);
    };
  },

  /**
   * The links the OS launched the app for (`deep_link_launch`): asked once the webview
   * listens, since the shell's own event for a cold start fires before it does. Empty
   * when there are none, or from a shell that predates the command.
   */
  async launchLinks(): Promise<string[]> {
    try {
      const urls = await invoke<unknown>("deep_link_launch");
      return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string") : [];
    } catch {
      return [];
    }
  },

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
): Promise<OpenedSignInPage> {
  if (android) {
    try {
      const answer = (await call("open_sign_in_tab", { url })) as { keptAlive?: unknown; keepAlive?: unknown } | null;
      return {
        via: "custom-tab",
        keptAlive: answer?.keptAlive === true,
        keepAlive: typeof answer?.keepAlive === "string" ? answer.keepAlive : "unknown",
      };
    } catch (error) {
      debugLog("auth", "custom-tab-failed", { reason: describeIpcError(error, "the tab did not open") });
      // Fall through to the system browser.
    }
  }
  await call("open_external", { url });
  return { via: "browser", keptAlive: false, keepAlive: android ? "none" : "not-needed" };
}

/** How `openSignInPage` opened Google, for the debug log. */
export type OpenedSignInPage = {
  via: "custom-tab" | "browser";
  /** Android: whether the sign-in keep-alive service started (`SignInKeepAliveService`). */
  keptAlive: boolean;
  keepAlive: string;
};

/**
 * Install an offer through the shell (`updater.rs`). Exported with its `invoke` as a
 * parameter, for tests.
 */
export async function installUpdateWith(
  offer: UpdateOffer,
  call: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
): Promise<InstallOutcome> {
  const outcome = (wire: unknown): InstallOutcome => {
    const kind = (wire as { kind?: unknown } | null)?.kind;
    const path = (wire as { path?: unknown } | null)?.path;
    if (kind === "opened") return typeof path === "string" ? { kind, path } : { kind };
    if (kind === "needs-permission" || kind === "restarting" || kind === "none") return { kind };
    throw new Error("the installer gave an unexpected answer");
  };
  try {
    switch (offer.action.kind) {
      // `beta`: the shell refuses a pre-release's files (a tag with a "-") unless the
      // offer came from the Beta channel. `manifest`: that channel's own latest.json.
      case "self":
        return outcome(await call("update_install", offer.action.manifest ? { manifest: offer.action.manifest } : undefined));
      case "deb":
        return outcome(
          await call("update_download_deb", { url: offer.action.asset.url, name: offer.action.asset.name, beta: offer.beta === true }),
        );
      case "apk":
        return outcome(
          await call("update_install_apk", { url: offer.action.asset.url, name: offer.action.asset.name, beta: offer.beta === true }),
        );
      default:
        return { kind: "none" };
    }
  } catch (error) {
    throw new Error(describeIpcError(error, "the update could not be installed"));
  }
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
    version: reportedVersion(typeof source.version === "string" ? source.version : "0.0.0"),
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

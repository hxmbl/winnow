/**
 * Tauri platform.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TokenSet } from "../core/gmail/dto";
import type { TokenStore } from "../core/gmail/tokens";
import type {
  NewMailNotification,
  Platform,
  PlatformInfo,
  SignInRequest,
  SignInResult,
} from "./types";

/** Events from Rust. */
const SYNC_TICK_EVENT = "winnow://sync-tick";
const DEEP_LINK_EVENT = "winnow://open-url";
const TRAY_ACTION_EVENT = "winnow://tray-action";

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

  oauthClientSecret(): undefined {
    return undefined;
  },

  async beginSignIn(request: SignInRequest): Promise<SignInResult> {
    const begun = await invoke<{ port: number; authorize_url: string }>("oauth_begin", {
      authorizeUrl: request.authorizeUrl,
    });
    activePort = begun.port;

    try {
      await invoke("open_external", { url: begun.authorize_url });
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

  async notifyNewMail(mail: NewMailNotification): Promise<void> {
    await invoke("notify_new_mail", {
      mail: {
        title: mail.title,
        body: mail.body,
        message_ids: mail.messageIds,
      },
    });
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

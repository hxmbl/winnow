/**
 * The Tauri platform.
 *
 * Every method here maps to one Rust command in `native/src-tauri/src/`. The
 * point of the file is that the *product* code above it never sees any of it:
 * the store asks for a notification, the web build answers with
 * `Notification`, the desktop build answers with a native one, and neither
 * knows the other exists.
 *
 * Note what is *not* here. There is no `readFile` / `writeFile` pair, because
 * the app has no business reading arbitrary paths — the previous version of
 * this file exposed exactly that, and it was never used by anything. The one
 * filesystem operation Winnow needs is "put this attachment somewhere the user
 * chose", and that is a single `save_attachment` command with a dialog behind
 * it.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TokenSet } from "../core/gmail/dto";
import type { TokenStore } from "../core/gmail/tokens";
import type {
  NewMailNotification,
  OAuthRedirect,
  Platform,
  PlatformInfo,
  SignInRequest,
} from "./types";

/** The event Rust emits on each background tick. Mirrors `scheduler.rs`. */
const SYNC_TICK_EVENT = "winnow://sync-tick";

/** The event Rust emits for a `winnow://` link. Mirrors `deep_link.rs`. */
const DEEP_LINK_EVENT = "winnow://open-url";

/** The event Rust emits for a tray menu choice. Mirrors `tray.rs`. */
const TRAY_ACTION_EVENT = "winnow://tray-action";

/** How the Rust `oauth_await` reply is shaped on the wire. */
type AuthOutcome =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; error: string; description: string; state: string };

/** The loopback port of an in-flight sign-in, so it can be cancelled. */
let activePort: number | null = null;

/** Secrets in the OS keychain, not in `localStorage`. */
const keychainTokenStore = (name = "gmail.tokens"): TokenStore => ({
  async read(): Promise<TokenSet | null> {
    const raw = await invoke<string | null>("secrets_get", { name });
    if (!raw) return null;
    return JSON.parse(raw) as TokenSet;
  },
  async write(tokens: TokenSet): Promise<void> {
    await invoke("secrets_set", { name, value: JSON.stringify(tokens) });
  },
  async clear(): Promise<void> {
    await invoke("secrets_delete", { name });
  },
});

export const desktopPlatform: Platform = {
  async info(): Promise<PlatformInfo> {
    return invoke<PlatformInfo>("app_info");
  },

  tokenStore(): TokenStore {
    return keychainTokenStore();
  },

  /**
   * Always nothing.
   *
   * Google classifies this build as an "installed app", which is forbidden from
   * presenting a client secret: the binary is on ten thousand machines and
   * anything in it is public. PKCE is the entire security story here — the code
   * cannot be exchanged without the verifier, which never leaves this machine
   * until the exchange itself.
   *
   * Returning `undefined` rather than reading the environment is deliberate. A
   * developer who sets `VITE_GMAIL_CLIENT_SECRET` for the web build and then
   * runs `npm run tauri:dev` gets a working desktop build with the secret simply
   * ignored, instead of a subtly wrong one that sends a secret Google will
   * reject anyway.
   */
  oauthClientSecret(): undefined {
    return undefined;
  },

  /**
   * Open the system browser and wait on the loopback listener.
   *
   * `request.authorizeUrl` carries a placeholder where the loopback port goes
   * (`__WINNOW_LOOPBACK_PORT__`, see `LOOPBACK_PORT_PLACEHOLDER`). Rust binds the
   * port first and substitutes the real one, then hands back the finished URL —
   * which is what gets opened. The alternative, asking for a port and then
   * building the URL in TypeScript, leaves a window in which the redirect URI
   * and the listening socket name different ports, and the symptom of getting
   * that wrong is a sign-in that hangs for five minutes and then blames the
   * user's network.
   *
   * The URL that comes back from Rust is the one opened, not the one sent in,
   * so there is no way to open an un-substituted URL by mistake.
   */
  async beginSignIn(request: SignInRequest): Promise<OAuthRedirect> {
    // Tauri v2 converts an `invoke` argument from camelCase to snake_case
    // automatically, so this reaches `oauth_begin(authorize_url: String)`.
    const begun = await invoke<{ port: number; authorizeUrl: string }>("oauth_begin", {
      authorizeUrl: request.authorizeUrl,
    });
    activePort = begun.port;

    // Opened from the app rather than navigated to, so the app stays alive and
    // the user can see it waiting.
    await invoke("open_external", { url: begun.authorizeUrl });

    try {
      return await invoke<AuthOutcome>("oauth_await", {
        port: begun.port,
        timeoutMs: request.timeoutMs,
      });
    } catch {
      // A timeout, a dropped listener, or a port the user walked away from.
      // All three are a cancellation from the user's side of the story rather
      // than a crash, and the session layer renders them as one.
      return { kind: "cancelled" };
    } finally {
      activePort = null;
    }
  },

  async cancelSignIn(): Promise<void> {
    if (activePort === null) return;
    const port = activePort;
    activePort = null;
    await invoke("oauth_cancel", { port }).catch(() => undefined);
  },

  async notifyNewMail(mail: NewMailNotification): Promise<void> {
    await invoke("notify_new_mail", {
      mail: { title: mail.title, body: mail.body, messageIds: mail.messageIds },
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

  /**
   * Tick on the Rust thread's schedule.
   *
   * Returns the unlisten function, which matters: the app calls this once, and
   * a leaked listener would keep a closure alive for the life of the process.
   */
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
    // `invoke` moves JSON, so the bytes go across base64-encoded. The choice of
    // base64 is the platform's, not the caller's.
    const base64 = bytesToBase64(bytes);
    return invoke<string | null>("save_attachment", { filename, bytesBase64: base64 });
  },

  async focusWindow(): Promise<void> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    await window.unminimize();
    await window.show();
    await window.setFocus();
  },
};

/** The desktop platform, plus the Rust event subscriptions it owns. */
export const desktopPlatformExtras = {
  /** Subscribe to `winnow://` links. Returns an unlisten function. */
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

  /** Subscribe to tray menu choices. Returns an unlisten function. */
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
 * Base64 for `invoke`.
 *
 * Chunked rather than `String.fromCharCode(...bytes)`: spreading a 10 MB
 * attachment overflows the argument limit and throws a `RangeError`, which
 * looked exactly like a corrupted download.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

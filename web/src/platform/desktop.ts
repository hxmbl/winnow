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
  Platform,
  PlatformInfo,
  SignInRequest,
  SignInResult,
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

/**
 * A sign-in that ran out of time.
 *
 * `timed?out` covers `timedout`, `timed-out` and `timeout`, because which one
 * arrives depends on the Tauri version's own error phrasing rather than on ours.
 */
const TIMED_OUT = /\btimed?[\s-]?out\b/i;

/**
 * A sign-in the user walked away from, as distinct from one that broke.
 *
 * **Every one of these needs the trailing `\w*`.** The pattern was
 * `/\b(cancel|abort|closed|disconnect|dropped)\b/i`, and the `\b` after the group
 * is what breaks it: a word boundary requires a non-word character on both sides,
 * so `cancel` matched but `cancelled` — two more letters — did not, nor
 * `canceled`, nor `aborted`. So the one message `types.ts` names as the canonical
 * example, "Sign-in was cancelled", classified as `unavailable`: reported as a
 * fault, which is the single outcome the union exists to prevent. `closed` has
 * the same problem (`close`/`closes`), and `abandon`/`cancell` are spelled
 * differently again.
 */
const ABANDONED = /\b(cancel|abort|close|disconnect|drop|abandon)\w*\b/i;

/**
 * Tear a listener down.
 *
 * Freeing the port is the point. A listener is a bound socket and a thread that runs
 * until it is told to stop, so a sign-in that failed after `oauth_begin` — the browser
 * would not open, say — leaves both running for the life of the process unless
 * something frees them. `oauth_cancel` is idempotent, so calling it for a port that is
 * already gone is fine.
 *
 * Also clears `activePort`, but only if it is *this* port. Two overlapping attempts are
 * not possible through `beginSignIn` (the UI disables the button), and clearing another
 * attempt's port would leave it uncancellable.
 */
async function abandonSignIn(port: number): Promise<void> {
  if (activePort === port) activePort = null;
  await invoke("oauth_cancel", { port }).catch(() => undefined);
}

/**
 * Secrets in the OS keychain, not in `localStorage`.
 *
 * `read` treats a parse failure as "no session" rather than propagating it. A
 * token blob written by a build whose `TokenSet` had different fields, or edited
 * by hand in the keychain, is not recoverable — but it is also not a reason to
 * fail sign-in. `TokenManager` distinguishes a store that failed from a store that
 * was empty precisely so the sign-in screen can say "your keychain is locked"
 * rather than looping forever on a value that will never parse.
 */
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
 * `app_info`, resolved once.
 *
 * What the build can do is a fixed property of the build — it does not change
 * while the app runs, and there is nothing to re-read. Both the entry point and
 * the app shell ask for it at startup, so without this each would pay a
 * round-trip to Rust for an answer that cannot have changed, and the two copies
 * would be free to drift if the struct ever did change.
 *
 * A rejected promise is not cached: a transient IPC failure should not pin the
 * app to "this build can do nothing" for the life of the process.
 *
 * **Both spellings are accepted, and neither is assumed.** The struct was
 * originally declared snake_case and read here as camelCase, so every capability
 * arrived `undefined`. The consequence was quiet and total: `backgroundSync` read
 * as `undefined`, the settings panel's whole Background section was gated on it,
 * and the desktop user could never turn background sync on — a feature that was
 * implemented, permissioned, and unreachable.
 *
 * `normaliseAppInfo` is the belt to that braces: it returns the desktop's own
 * answer when Rust gives it and `false` when it does not — never `undefined`,
 * which is what made the section not merely wrong but *absent*, with no error
 * anywhere. Rust now renames the fields explicitly (`nativeOAuth`, and not serde's
 * `nativeOauth`), so camelCase is the contract; the snake_case arm is what stops a
 * future struct change from failing this way again. `platform.test.ts` pins both
 * spellings on both sides.
 */
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
   * The URL that comes back from Rust is the one opened, not the one sent in, so
   * there is no way to open an un-substituted URL by mistake.
   *
   * **The reply is snake_case on purpose.** Tauri rewrites *argument* keys from
   * camelCase to snake_case, but it never rewrites *return values* — those go
   * through plain serde using the struct's own field names. Reading
   * `begun.authorizeUrl` from a struct Rust declared `authorize_url` produced
   * `undefined`, which was then passed to `open_external` as `url: undefined`; the
   * IPC rejected the call with "missing required key url", and since that `await`
   * sat outside the try below, `beginSignIn` rejected outright. Google sign-in on
   * the desktop was impossible, and the sign-in screen rendered the raw IPC error
   * as though it had come from Google. Hence the snake_case types at this boundary,
   * and `platform.test.ts` pinning the shape.
   */
  async beginSignIn(request: SignInRequest): Promise<SignInResult> {
    // Tauri v2 converts an `invoke` argument from camelCase to snake_case
    // automatically, so this reaches `oauth_begin(authorize_url: String)`.
    const begun = await invoke<{ port: number; authorize_url: string }>("oauth_begin", {
      authorizeUrl: request.authorizeUrl,
    });
    activePort = begun.port;

    try {
      // Opened from the app rather than navigated to, so the app stays alive and
      // the user can see it waiting. Inside the try, because failing here is the
      // same class of problem as failing to listen: nothing is waiting for a
      // redirect that is never going to arrive, and leaving the listener bound
      // would leak a thread and a socket for the life of the process.
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
      // A code on its own is not enough: the exchange must name the exact URI
      // Google saw — the one Rust substituted into the authorize URL, not the
      // placeholder the session still holds (`LOOPBACK_REDIRECT_URI`). Recover
      // it from the URL that was actually opened and hand it back with the code.
      if (outcome.kind !== "code") return outcome;
      const redirectUri = redirectUriIn(begun.authorize_url);
      return redirectUri ? { ...outcome, redirectUri } : outcome;
    } catch (error) {
      // Three genuinely different endings, and collapsing them into one
      // "cancelled" is what made a listener that never bound indistinguishable from
      // a user who closed the tab — so the sign-in screen told someone their click
      // had been ignored when nothing had been listening at all.
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
    // `message_ids` on the wire, for the same reason as every other reply here:
    // the camelCase rewrite applies to the *top-level* argument key (`mail`), not
    // to the fields inside the value it deserialises. Sending `messageIds` into a
    // struct with `#[serde(default)]` on `message_ids` deserialised *successfully*
    // with an empty vec — so the ids were dropped with no error at all, and a
    // notification click could never know which conversation to open.
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
    // `intervalSecs` → `interval_secs`: this one *is* rewritten, because it is a
    // top-level argument key. `null` is accepted by Tauri as `None` for an
    // `Option<u64>`, which is how the ticker is parked.
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

  /**
   * Raise the window.
   *
   * `unminimize` is not a no-op on a path where the app was launched from a tray
   * click or a `winnow://` link: that is exactly the situation this exists for,
   * and `setFocus` on a minimised window focuses nothing the user can see. The
   * call needs `core:window:allow-unminimize`, which `capabilities/default.json`
   * did not grant — so it was rejected, and because it was the *first* call in the
   * sequence, `show` and `setFocus` never ran. Every deep link and every tray
   * click on the running app therefore did nothing visible.
   *
   * The three calls are attempted independently rather than as a chain: they are
   * three permissions with three failure modes, and one missing permission should
   * not cost the other two. `focusWindow` is a best-effort convenience, so it
   * swallows its own errors — the alternative is an unhandled rejection in a path
   * that has nothing to report to.
   */
  async focusWindow(): Promise<void> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    await window.unminimize().catch(() => undefined);
    await window.show().catch(() => undefined);
    await window.setFocus().catch(() => undefined);
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

/**
 * Rust's `AppInfo`, in the spelling the wire actually uses.
 *
 * camelCase, because `commands.rs` renames every field explicitly rather than
 * relying on `rename_all = "camelCase"` — serde's camelCase of `native_oauth` is
 * `nativeOauth`, which is one capital letter away from what the UI reads and which
 * no compiler and no test would catch.
 *
 * `normaliseAppInfo` is why this type is not simply the return type of `invoke`: the
 * asymmetry is deliberate and worth recording. This is one of the two structs whose
 * field names are read by two languages, so the mismatch was invisible in both.
 * Normalising in one place means the wire format is whatever Rust says and the
 * contract is asserted once, here — and `platform.test.ts` checks the rename
 * attributes on the Rust side against the keys read below.
 */
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
  /** Also accepted, so a shell using the other spelling cannot read `false`. */
  native_oauth?: boolean;
  native_secrets?: boolean;
  background_sync?: boolean;
  save_files?: boolean;
};

/**
 * Accept either casing for the capability flags.
 *
 * Returns the desktop's own answer when Rust gives it, and `false` when it does
 * not — never `undefined`. `undefined` was the actual bug: `SettingsPanel` gates
 * its Background section on `backgroundSync !== null`, so an absent flag meant the
 * section was not merely wrong, it was *absent*, with no error anywhere.
 */
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

/**
 * Turn an IPC rejection into something worth showing a person.
 *
 * A rejected `invoke` arrives as a plain `Error` whose message is either the
 * Rust `Err` string or a Tauri's own "missing required key" phrasing — neither of
 * which means anything to someone whose sign-in just failed. The `fallback` says
 * what was being attempted, so the message has a subject even when the cause is
 * unrecognised.
 *
 * Truncated, because an IPC error can carry a whole serialised payload and the
 * sign-in screen has no room for it.
 */
function describeIpcError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const cleaned = message.trim().replace(/\s+/g, " ");
  if (!cleaned) return fallback;
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

/**
 * The redirect URI an authorize URL actually carries, decoded.
 *
 * The URL Rust returns has the placeholder replaced with the port it bound, so
 * this is the exact URI Google saw — the one the token exchange must repeat.
 * Returns `undefined` when the URL cannot be parsed or carries no `redirect_uri`;
 * the session then falls back to its own value, which for the desktop is the
 * placeholder — a case that should not occur, because Rust substitutes in place.
 */
function redirectUriIn(authorizeUrl: string): string | undefined {
  try {
    return new URL(authorizeUrl).searchParams.get("redirect_uri") ?? undefined;
  } catch {
    return undefined;
  }
}

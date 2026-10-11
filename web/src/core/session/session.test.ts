/**
 * Which redirect URI a build sends to Google.
 *
 * The defect these exist for: `redirectUri()` used to read
 * `webRedirectUriFromEnv() || LOOPBACK_REDIRECT_URI`, which interpreted an empty
 * `VITE_GMAIL_REDIRECT_URI` as "desktop". That is the desktop's *correct*
 * configuration — it has no registered URI and uses the loopback listener — so a
 * **web** build with no URI configured also fell through to the loopback
 * placeholder. Nothing substitutes it in a browser tab, so the browser navigated
 * to Google with `http://127.0.0.1:__WINNOW_LOOPBACK_PORT__/winnow-oauth` as the
 * `redirect_uri`, and Google answered `Error 400: invalid_request` naming a token
 * the code never appears to build.
 *
 * The choice now follows the platform's own capability (`nativeOAuth`) rather
 * than an environment variable that happens to be empty, and a web build with no
 * URI refuses loudly instead of sending a placeholder to Google.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailSession, LOOPBACK_PORT_PLACEHOLDER } from "./session";
import { GmailError } from "../gmail/dto";
import type { CursorStore, MailboxCache } from "../gmail/sync";
import type { TokenStore } from "../gmail/tokens";
import type { Platform, PlatformInfo, SignInRequest, SignInResult } from "../../platform/types";

/** A `PlatformInfo` for a host, with everything else filled in. */
function infoFor(kind: "desktop" | "web"): PlatformInfo {
  return {
    name: "Winnow",
    version: "0.1.0",
    os: kind === "desktop" ? "macos" : "browser",
    arch: "unknown",
    kind,
    nativeOAuth: kind === "desktop",
    nativeSecrets: kind === "desktop",
    backgroundSync: true,
    saveFiles: kind === "desktop",
  };
}

/**
 * A `Platform` that records the authorize URL it was handed and then reports the
 * user cancelled.
 *
 * Only the two methods `signIn` reaches for are real; the rest exist so the
 * object satisfies the interface without a cast of the whole thing. The captured
 * URL is the point: it is what would have been opened or navigated to, and so
 * what Google would have received.
 */
function platformFor(kind: "desktop" | "web"): { platform: Platform; opened: string[] } {
  const opened: string[] = [];
  const store: TokenStore = {
    read: async () => null,
    write: async () => {},
    clear: async () => {},
  };
  const platform = {
    info: async () => infoFor(kind),
    tokenStore: () => store,
    oauthClientSecret: () => undefined,
    async beginSignIn(request: SignInRequest): Promise<SignInResult> {
      opened.push(request.authorizeUrl);
      return { kind: "cancelled" };
    },
    cancelSignIn: async () => {},
    notifyNewMail: async () => {},
    requestNotificationPermission: async () => false,
    setUnreadBadge: async () => {},
    setBackgroundSync: async () => {},
    onBackgroundTick: () => () => {},
    openExternal: async () => {},
    saveFile: async () => null,
    focusWindow: async () => {},
  } as unknown as Platform;
  return { platform, opened };
}

/** The cache `GmailSession` is handed. `signIn` never touches it. */
const cache = {
  all: async () => [],
  upsert: async () => {},
  remove: async () => {},
  gmailIds: async () => [],
  keepOnly: async () => {},
  replace: async () => {},
  clear: async () => {},
  read: async () => null,
  write: async () => {},
} as unknown as MailboxCache & CursorStore;

/** The `redirect_uri` actually carried by an authorize URL. */
function redirectOf(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get("redirect_uri") ?? "";
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the sign-in redirect URI", () => {
  it("is the loopback placeholder on the desktop", async () => {
    vi.stubEnv("VITE_GMAIL_CLIENT_ID", "desktop.apps.googleusercontent.com");
    const { platform, opened } = platformFor("desktop");
    const session = new GmailSession(platform, cache);

    // The cancelled outcome is incidental; the captured URL is the assertion.
    await expect(session.signIn()).rejects.toMatchObject({ kind: "declined" });

    expect(opened).toHaveLength(1);
    expect(redirectOf(opened[0])).toBe(
      `http://127.0.0.1:${LOOPBACK_PORT_PLACEHOLDER}/winnow-oauth`,
    );
  });

  it("ignores a web redirect URI configured for the web build", async () => {
    // The other half of drawing the line at the platform: `tauri:dev` loads the
    // same `.env.local` as the site, so a developer who sets a web redirect URI
    // must not break the desktop build. Rust refuses a URL with no placeholder,
    // so honouring the variable here would fail sign-in with an IPC error.
    vi.stubEnv("VITE_GMAIL_CLIENT_ID", "desktop.apps.googleusercontent.com");
    vi.stubEnv("VITE_GMAIL_REDIRECT_URI", "https://app.example/auth/callback");
    const { platform, opened } = platformFor("desktop");
    const session = new GmailSession(platform, cache);

    await expect(session.signIn()).rejects.toMatchObject({ kind: "declined" });
    expect(redirectOf(opened[0])).toBe(
      `http://127.0.0.1:${LOOPBACK_PORT_PLACEHOLDER}/winnow-oauth`,
    );
  });

  it("is the configured URI on the web", async () => {
    vi.stubEnv("VITE_GMAIL_CLIENT_ID", "web.apps.googleusercontent.com");
    vi.stubEnv("VITE_GMAIL_REDIRECT_URI", "https://app.example/auth/callback");
    const { platform, opened } = platformFor("web");
    const session = new GmailSession(platform, cache);

    // `beginSignIn` reporting "cancelled" is incidental — the captured URL is
    // what matters, and it is captured before the outcome is read.
    await expect(session.signIn()).rejects.toMatchObject({ kind: "declined" });
    expect(redirectOf(opened[0])).toBe("https://app.example/auth/callback");
  });

  it("refuses on the web when no URI is configured, rather than sending the placeholder", async () => {
    // The reported failure, at its source. An empty variable is a configuration
    // error on the web, not a licence to use a port the browser cannot bind.
    vi.stubEnv("VITE_GMAIL_CLIENT_ID", "web.apps.googleusercontent.com");
    vi.stubEnv("VITE_GMAIL_REDIRECT_URI", "");
    const { platform, opened } = platformFor("web");
    const session = new GmailSession(platform, cache);

    const error = await session.signIn().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GmailError);
    expect((error as GmailError).kind).toBe("config");
    expect((error as GmailError).message).toContain("VITE_GMAIL_REDIRECT_URI");

    // Nothing was opened, so no URL carrying the placeholder can reach Google.
    expect(opened).toEqual([]);
  });
});

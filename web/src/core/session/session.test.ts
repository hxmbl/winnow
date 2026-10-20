/**
 * Which redirect URI a build sends to Google.
 *
 * The defect these exist for: `redirectUri()` used to read a build-time web
 * redirect URI and fall back to `LOOPBACK_REDIRECT_URI`, which interpreted an
 * empty variable as "desktop". That is the desktop's *correct*
 * configuration — it has no registered URI and uses the loopback listener — so a
 * **web** build with no URI configured also fell through to the loopback
 * placeholder. Nothing substitutes it in a browser tab, so the browser navigated
 * to Google with `http://127.0.0.1:__WINNOW_LOOPBACK_PORT__/winnow-oauth` as the
 * `redirect_uri`, and Google answered `Error 400: invalid_request` naming a token
 * the code never appears to build.
 *
 * The choice now follows the platform's own capability (`nativeOAuth`) rather
 * than an environment variable that happens to be empty. The web URI is now the
 * page's own address (there is no build-time configuration at all), and a page
 * with no address refuses loudly instead of sending a placeholder to Google.
 *
 * The last test here covers the second defect in the same flow: the web platform
 * used to answer `signIn`'s `beginSignIn` with `{ kind: "cancelled" }` the moment
 * it asked the browser to navigate. The session's continuation is a microtask and
 * microtasks run *before* the navigation, so it read "cancelled", discarded the
 * pending PKCE verifier, and the redirect back from Google found nothing to
 * exchange with — the "Sign-in could not be verified." a user actually got. The
 * web platform now never settles, and the verifier must survive.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailSession, LOOPBACK_PORT_PLACEHOLDER } from "./session";
import { takePendingAuth } from "./pendingAuth";
import { GmailError } from "../gmail/dto";
import type { CursorStore, MailboxCache } from "../gmail/sync";
import type { TokenStore } from "../gmail/tokens";
import type { Platform, PlatformInfo, SignInRequest, SignInResult } from "../../platform/types";
import type { OAuthClientCredentials } from "./credentials";

/** The OAuth client the user has "set up" for the test at hand. */
let storedClient: OAuthClientCredentials | null = null;

/** Stand in for the page's own address, which is the web build's redirect URI. */
function installLocation(origin: string, pathname = "/"): void {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin, pathname, search: "", hash: "" },
  });
}

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
 * A `Platform` that records the authorize URL it was handed and then behaves the
 * way the real host does: the desktop reports the user cancelled, the web
 * navigates and never settles.
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
    credentialStore: () => ({
      read: async () => storedClient,
      write: async (next: OAuthClientCredentials) => void (storedClient = next),
      clear: async () => void (storedClient = null),
    }),
    async beginSignIn(request: SignInRequest): Promise<SignInResult> {
      opened.push(request.authorizeUrl);
      if (kind === "web") {
        // Mirrors `web.ts`: the browser is navigating away, so the promise never
        // settles. Resolving here would be the bug — the session would read
        // "cancelled", discard the verifier, and the redirect back would fail.
        return new Promise<SignInResult>(() => {});
      }
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

/** Let the async sign-in body run out to the `beginSignIn` call. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait until the platform has been handed an authorize URL, and return it.
 *
 * The web flow never settles — `beginSignIn` hands the page to the browser and returns a
 * promise that stays pending forever — so the URL is the only observable, and it is
 * reached only after `createPkcePair` and a `platform.info()` round trip. Counting
 * `setTimeout(0)` ticks to get there was a race: `crypto.subtle` is a task rather than a
 * microtask, so under load two ticks were sometimes one too few and the assertion read
 * `new URL(undefined)` and reported "Invalid URL" about a test that had passed.
 */
async function authorizeUrlFor(opened: string[]): Promise<string> {
  for (let attempt = 0; attempt < 50 && opened.length === 0; attempt += 1) await flush();
  if (opened.length === 0) throw new Error("sign-in never reached the platform");
  return opened[0];
}

/** A minimal in-memory `sessionStorage`, since this suite runs in Node. */
function installSessionStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    },
  });
  return backing;
}

afterEach(() => {
  vi.unstubAllEnvs();
  storedClient = null;
  Reflect.deleteProperty(globalThis, "sessionStorage");
  Reflect.deleteProperty(globalThis, "location");
});

describe("the sign-in redirect URI", () => {
  it("is the loopback placeholder on the desktop", async () => {
    storedClient = { clientId: "desktop.apps.googleusercontent.com" };
    const { platform, opened } = platformFor("desktop");
    const session = new GmailSession(platform, cache);

    // The cancelled outcome is incidental; the captured URL is the assertion.
    await expect(session.signIn()).rejects.toMatchObject({ kind: "declined" });

    expect(opened).toHaveLength(1);
    expect(redirectOf(opened[0])).toBe(
      `http://127.0.0.1:${LOOPBACK_PORT_PLACEHOLDER}/winnow-oauth`,
    );
  });

  it("ignores the webview's own address on the desktop", async () => {
    // The other half of drawing the line at the platform: a desktop webview has a
    // location too (`tauri://localhost`, or the dev server under `tauri:dev`), and
    // Rust refuses a URL with no placeholder, so using it here would fail sign-in
    // with an IPC error.
    storedClient = { clientId: "desktop.apps.googleusercontent.com" };
    installLocation("http://localhost:5173");
    const { platform, opened } = platformFor("desktop");
    const session = new GmailSession(platform, cache);

    await expect(session.signIn()).rejects.toMatchObject({ kind: "declined" });
    expect(redirectOf(opened[0])).toBe(
      `http://127.0.0.1:${LOOPBACK_PORT_PLACEHOLDER}/winnow-oauth`,
    );
  });

  it("is the app's own address on the web", async () => {
    storedClient = { clientId: "web.apps.googleusercontent.com", clientSecret: "web-secret" };
    installLocation("https://app.example");
    const { platform, opened } = platformFor("web");
    const session = new GmailSession(platform, cache);

    // The web flow navigates rather than settling: `beginSignIn` never resolves
    // (mirroring `web.ts`), so `signIn()` is still in flight after the URL has
    // been built. The captured URL is the assertion, and it was captured before
    // any outcome could have been read.
    const inflight = session.signIn();
    const authorizeUrl = await authorizeUrlFor(opened);

    expect(redirectOf(authorizeUrl)).toBe("https://app.example/");

    // And the promise must not have settled: nothing has happened yet, the
    // page has simply been handed to the browser.
    let settled = false;
    void inflight.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(settled).toBe(false);
  });

  it("refuses on the web when the page has no address, rather than sending the placeholder", async () => {
    // The reported failure, at its source. No address to return to is a
    // configuration error on the web, not a licence to use a port the browser
    // cannot bind.
    storedClient = { clientId: "web.apps.googleusercontent.com", clientSecret: "web-secret" };
    const { platform, opened } = platformFor("web");
    const session = new GmailSession(platform, cache);

    const error = await session.signIn().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GmailError);
    expect((error as GmailError).kind).toBe("config");
    expect((error as GmailError).message).toContain("web address");

    // Nothing was opened, so no URL carrying the placeholder can reach Google.
    expect(opened).toEqual([]);
  });

  it("keeps the PKCE verifier stashed while the browser navigates", async () => {
    // The root of the reported failure: `web.ts` used to answer `beginSignIn`
    // with `{ kind: "cancelled" }` the moment it asked the browser to navigate.
    // The session's continuation is a microtask and microtasks run before the
    // navigation, so it read "cancelled", called `forgetPendingAuth`, and the
    // redirect back from Google found no verifier to exchange the code with —
    // every web sign-in ended in "Sign-in could not be verified." The platform
    // now never settles, and the stash has to be there when the page returns.
    installSessionStorage();
    storedClient = { clientId: "web.apps.googleusercontent.com", clientSecret: "web-secret" };
    installLocation("https://app.example");
    const { platform, opened } = platformFor("web");
    const session = new GmailSession(platform, cache);

    const inflight = session.signIn();

    // Not two `flush()`es: `crypto.subtle` is a task, so under load that raced (see
    // `authorizeUrlFor`).
    const state = new URL(await authorizeUrlFor(opened)).searchParams.get("state") ?? "";
    expect(state).not.toBe("");
    expect(takePendingAuth(state)?.verifier).toBeTruthy();

    // And nothing has settled: the page is mid-navigation, not failed.
    let settled = false;
    void inflight.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(settled).toBe(false);
  });
});
/**
 * Google Drive (large files as links), from the session's side: the grant read off the
 * token, the incremental `drive.file` opt-in (alone, never at sign-in), the wrong-account
 * refusal, and sign-out revoking the grant with everything else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailSession } from "./session";
import { GMAIL_SCOPE, GOOGLE_REVOKE_URL, type TokenSet } from "../gmail/dto";
import { DRIVE_FILE_SCOPE } from "../gmail/drive";
import type { CursorStore, MailboxCache } from "../gmail/sync";
import type { TokenStore } from "../gmail/tokens";
import type { Platform, PlatformInfo, SignInRequest, SignInResult } from "../../platform/types";
import type { OAuthClientCredentials } from "./credentials";

let storedClient: OAuthClientCredentials | null = null;

const info: PlatformInfo = {
  name: "Winnow",
  version: "0.1.0",
  os: "macos",
  arch: "unknown",
  kind: "desktop",
  nativeOAuth: true,
  nativeSecrets: true,
  backgroundSync: true,
  saveFiles: true,
};

function memoryTokens(initial: TokenSet | null) {
  let current = initial;
  const store: TokenStore = {
    read: async () => current,
    write: async (tokens) => void (current = tokens),
    clear: async () => void (current = null),
  };
  return { store, current: () => current };
}

function platformFor(tokens: TokenStore): { platform: Platform; opened: string[] } {
  const opened: string[] = [];
  const platform = {
    info: async () => info,
    tokenStore: () => tokens,
    credentialStore: () => ({
      read: async () => storedClient,
      write: async (next: OAuthClientCredentials) => void (storedClient = next),
      clear: async () => void (storedClient = null),
    }),
    async beginSignIn(request: SignInRequest): Promise<SignInResult> {
      opened.push(request.authorizeUrl);
      const state = new URL(request.authorizeUrl).searchParams.get("state") ?? "";
      return { kind: "code", code: "auth-code", state, redirectUri: "http://127.0.0.1:5555/winnow-oauth" };
    },
    cancelSignIn: async () => {},
  } as unknown as Platform;
  return { platform, opened };
}

const cache = {
  all: async () => [],
  clear: async () => {},
} as unknown as MailboxCache & CursorStore;

let grantedScope: string;
let profileEmail: string;
/** Profiles answered in turn (the last one repeats), when set. */
let profiles: string[];
let revoked: string[];

function installGoogle(): void {
  vi.stubGlobal("fetch", async (input: string, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input));
    if (url.href.startsWith(GOOGLE_REVOKE_URL)) {
      revoked.push(String(init?.body ?? url.search));
      return new Response("", { status: 200 });
    }
    if (url.origin === "https://oauth2.googleapis.com") {
      return new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "r", expires_in: 3600, scope: grantedScope }),
        { status: 200 },
      );
    }
    if (url.pathname.endsWith("/users/me/profile")) {
      const email = profiles.length > 1 ? profiles.shift()! : (profiles[0] ?? profileEmail);
      return new Response(JSON.stringify({ emailAddress: email, historyId: "1" }), { status: 200 });
    }
    return new Response("not stubbed", { status: 500 });
  });
}

const signedIn = (scope = GMAIL_SCOPE): TokenSet => ({
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: Date.now() + 3_600_000,
  scope,
});

function sessionWith(scope: string | null = GMAIL_SCOPE) {
  const tokens = memoryTokens(scope === null ? null : signedIn(scope));
  const { platform, opened } = platformFor(tokens.store);
  return { session: new GmailSession(platform, cache), tokens, opened };
}

beforeEach(() => {
  storedClient = { clientId: "desktop.apps.googleusercontent.com" };
  grantedScope = `${GMAIL_SCOPE} ${DRIVE_FILE_SCOPE}`;
  profileEmail = "me@example.com";
  profiles = [];
  revoked = [];
  installGoogle();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Drive grant", () => {
  it("is read off the stored token", async () => {
    expect(await sessionWith().session.driveAccess()).toBe("not_granted");
    expect(await sessionWith(`${GMAIL_SCOPE} ${DRIVE_FILE_SCOPE}`).session.driveAccess()).toBe("granted");
    expect(await sessionWith(null).session.driveAccess()).toBe("unavailable");
  });

  it("is never asked for at sign-in", async () => {
    grantedScope = GMAIL_SCOPE;
    const { session, opened } = sessionWith(null);
    await session.signIn();
    const scope = new URL(opened[0]!).searchParams.get("scope") ?? "";
    expect(scope).not.toContain("drive");
    expect(await session.driveAccess()).toBe("not_granted");
  });

  it("asks for drive.file alone, on top of the existing grant, for the same account", async () => {
    const { session, opened } = sessionWith();
    expect(await session.grantDrive()).toBe("granted");
    const query = new URL(opened[0]!).searchParams;
    // A grant from before the basic profile also asks for it on the same trip (STRM-461).
    expect(query.get("scope")).toBe(`${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/userinfo.profile`);
    expect(query.get("include_granted_scopes")).toBe("true");
    expect(query.get("login_hint")).toBe("me@example.com");
  });

  it("refuses a consent approved for another account and keeps the old grant", async () => {
    const { session, tokens } = sessionWith();
    const before = tokens.current();
    // The client keeps the fetch it was built with, so the stub answers in turn.
    profiles = ["me@example.com", "someone@else.com"];
    await expect(session.grantDrive()).rejects.toThrow(/someone@else\.com/);
    expect(tokens.current()?.accessToken).toBe(before?.accessToken);
    expect(await session.driveAccess()).toBe("not_granted");
  });

  it("goes with sign-out: the grant is revoked and nothing is left to read", async () => {
    const { session } = sessionWith(`${GMAIL_SCOPE} ${DRIVE_FILE_SCOPE}`);
    await session.signOut({ revoke: true });
    expect(await session.driveAccess()).toBe("unavailable");
    await vi.waitFor(() => expect(revoked.length).toBeGreaterThan(0));
  });

  it("needs a session before it can ask", async () => {
    await expect(sessionWith(null).session.grantDrive()).rejects.toThrow(/Sign in/);
  });
});

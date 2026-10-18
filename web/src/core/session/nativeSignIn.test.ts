/**
 * Native Android sign-in: the pure decisions, and the session's use of them.
 *
 * The contract: a native code is exchanged with the Web client and its secret, and the
 * session remembers that client for every refresh; anything short of a code (no Play
 * services, DEVELOPER_ERROR, a failed exchange) runs the browser flow instead, exactly
 * as before; closing Google's sheet stops the sign-in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailSession } from "./session";
import {
  browserFallbackScope,
  refreshClientFor,
  scopeList,
  sessionStrandedBy,
  unionScopes,
} from "./nativeSignIn";
import {
  normaliseCredentials,
  parseStoredCredentials,
  validateNativeClient,
  type OAuthClientCredentials,
} from "./credentials";
import { GMAIL_SCOPE, GOOGLE_TOKEN_URL, GmailError, type TokenSet } from "../gmail/dto";
import type { CursorStore, MailboxCache } from "../gmail/sync";
import type { TokenStore } from "../gmail/tokens";
import type {
  NativeSignInRequest,
  NativeSignInResult,
  Platform,
  PlatformInfo,
  SignInRequest,
  SignInResult,
} from "../../platform/types";

const DESKTOP_ID = "111-desktop.apps.googleusercontent.com";
const WEB_ID = "222-web.apps.googleusercontent.com";
// Built at run time, like `CLIENT_SECRET_PREFIX`: no literal secret prefix in the source.
const WEB_SECRET = [["GOC", "SPX"].join(""), "native-test-secret"].join("-");
const CONTACTS = "https://www.googleapis.com/auth/contacts.readonly";

const both: OAuthClientCredentials = {
  clientId: DESKTOP_ID,
  nativeAndroid: { clientId: WEB_ID, clientSecret: WEB_SECRET },
};

describe("scopes", () => {
  it("are split, deduplicated and kept in order", () => {
    expect(scopeList(`${GMAIL_SCOPE}  ${CONTACTS}`, undefined, GMAIL_SCOPE)).toEqual([GMAIL_SCOPE, CONTACTS]);
    expect(unionScopes(GMAIL_SCOPE, CONTACTS, "")).toBe(`${GMAIL_SCOPE} ${CONTACTS}`);
  });

  it("a browser fallback re-asks for the session's scopes only when another client owns it", () => {
    expect(browserFallbackScope(CONTACTS, { scope: GMAIL_SCOPE, clientId: WEB_ID }, true)).toBe(
      `${GMAIL_SCOPE} ${CONTACTS}`,
    );
    expect(browserFallbackScope(CONTACTS, { scope: GMAIL_SCOPE }, true)).toBe(CONTACTS);
    expect(browserFallbackScope(GMAIL_SCOPE, { scope: GMAIL_SCOPE, clientId: WEB_ID }, false)).toBe(GMAIL_SCOPE);
    expect(browserFallbackScope(CONTACTS, null, true)).toBe(CONTACTS);
  });
});

describe("the client a refresh uses", () => {
  it("is the Web client for a native session, the main client otherwise", () => {
    expect(refreshClientFor(both, WEB_ID)).toEqual({ clientId: WEB_ID, clientSecret: WEB_SECRET });
    expect(refreshClientFor(both, undefined)).toEqual({ clientId: DESKTOP_ID, clientSecret: undefined });
    expect(refreshClientFor({ clientId: DESKTOP_ID }, WEB_ID)).toEqual({ clientId: DESKTOP_ID, clientSecret: undefined });
    expect(refreshClientFor(null, WEB_ID)).toBeNull();
  });
});

describe("saving a client", () => {
  it("strands every session when the main client changes", () => {
    expect(sessionStrandedBy(both, { ...both, clientId: "333.apps.googleusercontent.com" }, undefined)).toBe(true);
    expect(sessionStrandedBy(both, { ...both, clientSecret: "x" }, WEB_ID)).toBe(true);
  });

  it("strands a native session when its Web client changes or goes, and nothing else", () => {
    expect(sessionStrandedBy(both, { clientId: DESKTOP_ID }, WEB_ID)).toBe(true);
    expect(
      sessionStrandedBy(both, { ...both, nativeAndroid: { clientId: WEB_ID, clientSecret: "other" } }, WEB_ID),
    ).toBe(true);
    expect(sessionStrandedBy(both, both, WEB_ID)).toBe(false);
    // A browser session survives the Android client coming and going.
    expect(sessionStrandedBy(both, { clientId: DESKTOP_ID }, undefined)).toBe(false);
    expect(sessionStrandedBy({ clientId: DESKTOP_ID }, both, undefined)).toBe(false);
  });
});

describe("the stored Android client", () => {
  it("survives a save and a read, and half of one is dropped", () => {
    const saved = JSON.stringify(normaliseCredentials({ ...both, nativeAndroid: { clientId: ` ${WEB_ID} `, clientSecret: WEB_SECRET } }));
    expect(parseStoredCredentials(saved)).toEqual(both);
    expect(normaliseCredentials({ clientId: DESKTOP_ID, nativeAndroid: { clientId: WEB_ID, clientSecret: " " } })).toEqual({
      clientId: DESKTOP_ID,
    });
    expect(
      parseStoredCredentials(JSON.stringify({ clientId: DESKTOP_ID, nativeAndroid: { clientId: "nope", clientSecret: WEB_SECRET } })),
    ).toEqual({ clientId: DESKTOP_ID });
  });

  it("is validated as a separate Web application client, and may be left blank", () => {
    expect(validateNativeClient({ clientId: "", clientSecret: "" }, DESKTOP_ID)).toEqual({});
    expect(validateNativeClient({ clientId: WEB_ID, clientSecret: WEB_SECRET }, DESKTOP_ID)).toEqual({});
    expect(validateNativeClient({ clientId: DESKTOP_ID, clientSecret: WEB_SECRET }, DESKTOP_ID).clientId).toMatch(/Desktop app client/);
    expect(validateNativeClient({ clientId: WEB_ID, clientSecret: "" }, DESKTOP_ID).clientSecret).toMatch(/needs its client secret/);
    expect(validateNativeClient({ clientId: "", clientSecret: WEB_SECRET }, DESKTOP_ID).clientId).toBeTruthy();
  });
});

// ── The session ──────────────────────────────────────────────────────────────

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

const androidInfo: PlatformInfo = {
  name: "Winnow",
  version: "0.0.0",
  os: "android",
  arch: "aarch64",
  kind: "desktop",
  nativeOAuth: true,
  nativeSecrets: true,
  backgroundSync: false,
  saveFiles: true,
};

type Harness = {
  platform: Platform;
  tokens: () => TokenSet | null;
  nativeCalls: NativeSignInRequest[];
  browserCalls: SignInRequest[];
};

function harness(
  credentials: OAuthClientCredentials,
  native: (request: NativeSignInRequest) => NativeSignInResult,
  initial: TokenSet | null = null,
): Harness {
  let stored = initial;
  const nativeCalls: NativeSignInRequest[] = [];
  const browserCalls: SignInRequest[] = [];
  const store: TokenStore = {
    read: async () => stored,
    write: async (next) => void (stored = next),
    clear: async () => void (stored = null),
  };
  const platform = {
    info: async () => androidInfo,
    tokenStore: () => store,
    credentialStore: () => ({ read: async () => credentials, write: async () => {}, clear: async () => {} }),
    async nativeGoogleSignIn(request: NativeSignInRequest) {
      nativeCalls.push(request);
      return native(request);
    },
    async beginSignIn(request: SignInRequest): Promise<SignInResult> {
      browserCalls.push(request);
      // The browser flow is not what these tests are about: stop it where it starts.
      return { kind: "cancelled" };
    },
    cancelSignIn: async () => {},
  } as unknown as Platform;
  return { platform, tokens: () => stored, nativeCalls, browserCalls };
}

let tokenBodies: URLSearchParams[];
let tokenAnswer: () => Response;

beforeEach(() => {
  tokenBodies = [];
  tokenAnswer = () =>
    new Response(
      JSON.stringify({ access_token: "native-access", refresh_token: "native-refresh", expires_in: 3600, scope: GMAIL_SCOPE }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url === GOOGLE_TOKEN_URL) {
      tokenBodies.push(new URLSearchParams(String(init?.body ?? "")));
      return tokenAnswer();
    }
    if (url.includes("/gmail/v1/users/me/profile")) {
      return new Response(JSON.stringify({ emailAddress: "me@example.com", historyId: "1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const code = (): NativeSignInResult => ({ kind: "code", code: "4/native-code", grantedScopes: [GMAIL_SCOPE] });

describe("GmailSession with native sign-in", () => {
  it("exchanges the native code with the Web client and keeps it for refreshes", async () => {
    const h = harness(both, code);
    const session = new GmailSession(h.platform, cache);

    await expect(session.signIn()).resolves.toEqual({ email: "me@example.com" });

    expect(h.nativeCalls).toEqual([{ serverClientId: WEB_ID, scopes: [GMAIL_SCOPE] }]);
    expect(h.browserCalls).toHaveLength(0);
    const exchange = tokenBodies[0]!;
    expect(exchange.get("client_id")).toBe(WEB_ID);
    expect(exchange.get("client_secret")).toBe(WEB_SECRET);
    expect(exchange.get("code")).toBe("4/native-code");
    expect(exchange.get("redirect_uri")).toBe("");
    expect(exchange.has("code_verifier")).toBe(false);
    expect(h.tokens()).toMatchObject({ refreshToken: "native-refresh", clientId: WEB_ID });

    // A refresh goes out under the Web client too.
    await session.tokens.forceRefresh();
    const refresh = tokenBodies[1]!;
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("client_id")).toBe(WEB_ID);
    expect(refresh.get("client_secret")).toBe(WEB_SECRET);
    expect(h.tokens()?.clientId).toBe(WEB_ID);
  });

  for (const reason of ["developer_error", "no_play_services", "network", "failed", "unsupported"] as const) {
    it(`falls back to the browser on ${reason}`, async () => {
      const h = harness(both, () => ({ kind: "unavailable", reason, detail: "test" }));
      const session = new GmailSession(h.platform, cache);

      // The stub browser "cancels", which is how the test sees the fallback ran.
      await expect(session.signIn()).rejects.toThrow(/cancelled/);
      expect(h.nativeCalls).toHaveLength(1);
      expect(h.browserCalls).toHaveLength(1);
      expect(new URL(h.browserCalls[0]!.authorizeUrl).searchParams.get("client_id")).toBe(DESKTOP_ID);
      expect(tokenBodies).toHaveLength(0);
      expect(session.lastNativeFallback).toMatch(new RegExp(`^${reason}`));
    });
  }

  it("falls back to the browser when Google refuses the exchange", async () => {
    tokenAnswer = () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
    const h = harness(both, code);
    const session = new GmailSession(h.platform, cache);

    await expect(session.signIn()).rejects.toThrow(/cancelled/);
    expect(h.browserCalls).toHaveLength(1);
    expect(session.lastNativeFallback).toMatch(/^exchange/);
  });

  it("stops when the user closes Google's sheet", async () => {
    const h = harness(both, () => ({ kind: "cancelled" }));
    const session = new GmailSession(h.platform, cache);

    const failure = await session.signIn().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GmailError);
    expect((failure as GmailError).kind).toBe("declined");
    expect(h.browserCalls).toHaveLength(0);
  });

  it("never asks Play services without an Android client", async () => {
    const h = harness({ clientId: DESKTOP_ID }, code);
    const session = new GmailSession(h.platform, cache);

    await expect(session.signIn()).rejects.toThrow(/cancelled/);
    expect(h.nativeCalls).toHaveLength(0);
    expect(h.browserCalls).toHaveLength(1);
  });

  it("an incremental grant asks the native client for the session's scopes as well", async () => {
    const before: TokenSet = { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, scope: GMAIL_SCOPE, clientId: WEB_ID };
    tokenAnswer = () =>
      new Response(
        JSON.stringify({ access_token: "b", refresh_token: "r2", expires_in: 3600, scope: `${GMAIL_SCOPE} ${CONTACTS}` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const h = harness(both, code, before);
    const session = new GmailSession(h.platform, cache);

    await session.grantContacts();
    expect(h.nativeCalls[0]!.scopes[0]).toBe(GMAIL_SCOPE);
    expect(h.nativeCalls[0]!.scopes).toContain(CONTACTS);
  });
});

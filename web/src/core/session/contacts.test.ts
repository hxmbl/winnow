/**
 * The Google contacts opt-in, from the session's side.
 *
 * Three promises are pinned here. The sign-in never asks for contacts. The opt-in asks
 * for exactly the two contact scopes *on top of* the existing grant
 * (`include_granted_scopes`), through the same platform flow as sign-in — loopback on the
 * desktop, a navigation on the web. And a consent approved for a *different* Google
 * account is refused, with the previous tokens put back, on both hosts.
 *
 * Google is a stub `fetch` routed by URL: the token endpoint, Gmail's profile, and the
 * two People listings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailSession } from "./session";
import { rememberPendingAuth } from "./pendingAuth";
import { GMAIL_SCOPE, GmailError, PROFILE_SCOPE, SIGN_IN_SCOPE, type TokenSet } from "../gmail/dto";
import { CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE } from "../gmail/people";
import type { GoogleContactsSnapshot, GoogleContactsStore } from "../contacts/google";
import type { CursorStore, MailboxCache } from "../gmail/sync";
import type { TokenStore } from "../gmail/tokens";
import type { Platform, PlatformInfo, SignInRequest, SignInResult } from "../../platform/types";
import type { OAuthClientCredentials } from "./credentials";

/** The OAuth client the user has "set up" for the test at hand. */
let storedClient: OAuthClientCredentials | null = null;

const ALL_SCOPES = `${GMAIL_SCOPE} ${CONTACTS_SCOPE} ${OTHER_CONTACTS_SCOPE}`;

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

/** A token store in memory, starting from `initial`. */
function memoryTokens(initial: TokenSet | null) {
  let current = initial;
  const store: TokenStore = {
    read: async () => current,
    write: async (tokens) => {
      current = tokens;
    },
    clear: async () => {
      current = null;
    },
  };
  return { store, current: () => current };
}

/**
 * A platform whose sign-in answers with `outcome`, echoing the state it was handed so the
 * session's state check passes the way a real redirect would.
 */
function platformFor(
  kind: "desktop" | "web",
  tokens: TokenStore,
  outcome: "code" | "access_denied" = "code",
): { platform: Platform; opened: string[] } {
  const opened: string[] = [];
  const platform = {
    info: async () => infoFor(kind),
    tokenStore: () => tokens,
    credentialStore: () => ({
      read: async () => storedClient,
      write: async (next: OAuthClientCredentials) => void (storedClient = next),
      clear: async () => void (storedClient = null),
    }),
    async beginSignIn(request: SignInRequest): Promise<SignInResult> {
      opened.push(request.authorizeUrl);
      if (kind === "web") return new Promise<SignInResult>(() => {});
      const state = new URL(request.authorizeUrl).searchParams.get("state") ?? "";
      if (outcome === "access_denied") {
        return { kind: "error", error: "access_denied", description: "", state };
      }
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

function memoryContacts() {
  let saved: GoogleContactsSnapshot | null = null;
  const store: GoogleContactsStore = {
    read: async () => saved,
    write: async (snapshot) => {
      saved = snapshot;
    },
    clear: async () => {
      saved = null;
    },
  };
  return { store, saved: () => saved };
}

function sessionFor(
  kind: "desktop" | "web",
  tokens: TokenStore,
  options: { outcome?: "code" | "access_denied"; contacts?: GoogleContactsStore } = {},
): { session: GmailSession; opened: string[] } {
  const { platform, opened } = platformFor(kind, tokens, options.outcome);
  return { session: new GmailSession(platform, cache, options.contacts ?? memoryContacts().store), opened };
}

/** What Google says, adjustable per test. */
type Google = {
  /** The `scope` the token endpoint grants. */
  grantedScope: string;
  /** The addresses `profile` returns, in order; the last one repeats. */
  profiles: string[];
  /** A People response, or a status to fail with. */
  people: { status: number; body: string };
  /** The userinfo answer; a picture by default. */
  userinfo?: { status: number; body: string };
  requests: string[];
};

function installGoogle(google: Google): void {
  vi.stubGlobal("fetch", async (input: string) => {
    const url = String(input);
    google.requests.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: google.grantedScope }),
        { status: 200 },
      );
    }
    if (url.includes("/users/me/profile")) {
      const email = google.profiles.length > 1 ? google.profiles.shift()! : google.profiles[0];
      return new Response(JSON.stringify({ emailAddress: email, historyId: "1" }), { status: 200 });
    }
    if (url.startsWith("https://people.googleapis.com/")) {
      return new Response(google.people.body, { status: google.people.status });
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      const answer = google.userinfo ?? { status: 200, body: JSON.stringify({ picture: "https://lh3.googleusercontent.com/a/me=s100" }) };
      return new Response(answer.body, { status: answer.status });
    }
    return new Response("not stubbed", { status: 500 });
  });
}

const signedIn = (scope = GMAIL_SCOPE): TokenSet => ({
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: Date.now() + 3_600_000,
  scope,
});

let google: Google;

beforeEach(() => {
  storedClient = { clientId: "desktop.apps.googleusercontent.com" };
  google = {
    grantedScope: ALL_SCOPES,
    profiles: ["me@example.com"],
    people: { status: 200, body: JSON.stringify({ connections: [], nextSyncToken: "s1" }) },
    requests: [],
  };
  installGoogle(google);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "sessionStorage");
  Reflect.deleteProperty(globalThis, "location");
  Reflect.deleteProperty(globalThis, "history");
});

describe("contactsAccess", () => {
  it("reads the grant off the stored token", async () => {
    const none = sessionFor("desktop", memoryTokens(null).store).session;
    expect(await none.contactsAccess()).toBe("unavailable");

    const gmailOnly = sessionFor("desktop", memoryTokens(signedIn()).store).session;
    expect(await gmailOnly.contactsAccess()).toBe("not_granted");

    const both = sessionFor("desktop", memoryTokens(signedIn(ALL_SCOPES)).store).session;
    expect(await both.contactsAccess()).toBe("granted");
  });
});

describe("the sign-in asks for mail and the basic profile only", () => {
  it("never names a contact scope or include_granted_scopes at first sign-in", async () => {
    google.grantedScope = SIGN_IN_SCOPE;
    const tokens = memoryTokens(null);
    const { session, opened } = sessionFor("desktop", tokens.store);

    await session.signIn();

    const query = new URL(opened[0]).searchParams;
    expect(query.get("scope")).toBe(`${GMAIL_SCOPE} ${PROFILE_SCOPE}`);
    expect(query.has("include_granted_scopes")).toBe(false);
    expect(await session.contactsAccess()).toBe("not_granted");
  });
});

describe("grantContacts — desktop", () => {
  it("asks for both contact scopes on top of the existing grant, for the signed-in account", async () => {
    const tokens = memoryTokens(signedIn());
    const { session, opened } = sessionFor("desktop", tokens.store);

    expect(await session.grantContacts()).toBe("granted");

    const query = new URL(opened[0]).searchParams;
    expect(query.get("scope")?.split(" ").sort()).toEqual([CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE].sort());
    expect(query.get("include_granted_scopes")).toBe("true");
    expect(query.get("login_hint")).toBe("me@example.com");
    expect(query.get("code_challenge_method")).toBe("S256");
    // The new token replaced the old one, carrying every scope.
    expect(tokens.current()?.accessToken).toBe("new-access");
    expect(tokens.current()?.scope).toBe(ALL_SCOPES);
  });

  it("refuses a consent approved for another account and puts the old tokens back", async () => {
    google.profiles = ["me@example.com", "someone.else@example.com"];
    const before = signedIn();
    const tokens = memoryTokens(before);
    const session = sessionFor("desktop", tokens.store).session;

    const error = await session.grantContacts().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GmailError);
    expect((error as GmailError).message).toContain("someone.else@example.com");
    expect(tokens.current()).toEqual(before);
  });

  it("says the contacts were not connected when the user declines, and changes nothing", async () => {
    const before = signedIn();
    const tokens = memoryTokens(before);
    const session = sessionFor("desktop", tokens.store, { outcome: "access_denied" }).session;

    const error = await session.grantContacts().catch((caught: unknown) => caught);

    expect((error as GmailError).kind).toBe("declined");
    expect((error as GmailError).message).toMatch(/contacts were not connected/i);
    expect(tokens.current()).toEqual(before);
  });

  it("reports a half grant as not granted", async () => {
    google.grantedScope = `${GMAIL_SCOPE} ${CONTACTS_SCOPE}`;
    const session = sessionFor("desktop", memoryTokens(signedIn()).store).session;
    expect(await session.grantContacts()).toBe("not_granted");
  });

  it("needs a session to add to", async () => {
    const session = sessionFor("desktop", memoryTokens(null).store).session;
    await expect(session.grantContacts()).rejects.toMatchObject({ kind: "reauth_required" });
  });
});

describe("refreshContacts", () => {
  it("does not touch the People API without the grant", async () => {
    const session = sessionFor("desktop", memoryTokens(signedIn()).store).session;
    expect(await session.refreshContacts()).toBeNull();
    expect(google.requests.some((url) => url.includes("people.googleapis.com"))).toBe(false);
  });

  it("lists both sources with the grant, and stores the result", async () => {
    google.people = {
      status: 200,
      body: JSON.stringify({
        connections: [{ resourceName: "people/c1", names: [{ displayName: "Ada" }], emailAddresses: [{ value: "ada@example.com" }] }],
        otherContacts: [{ resourceName: "otherContacts/c1", emailAddresses: [{ value: "lin@example.com" }] }],
        nextSyncToken: "tok",
      }),
    };
    const contacts = memoryContacts();
    const session = sessionFor("desktop", memoryTokens(signedIn(ALL_SCOPES)).store, { contacts: contacts.store }).session;

    const rows = await session.refreshContacts();

    expect(rows?.map((row) => [row.address, row.source])).toEqual([
      ["ada@example.com", "saved"],
      ["lin@example.com", "other"],
    ]);
    const people = google.requests.filter((url) => url.includes("people.googleapis.com"));
    expect(people.some((url) => url.includes("/people/me/connections"))).toBe(true);
    expect(people.some((url) => url.includes("/otherContacts"))).toBe(true);
    expect(contacts.saved()?.saved.syncToken).toBe("tok");
  });

  it("erases the local copy when Google says the grant was revoked", async () => {
    const contacts = memoryContacts();
    await contacts.store.write({
      version: 3,
      saved: { syncToken: "s", people: { "people/c1": { name: "Ada", emails: ["ada@example.com"] } } },
      other: { people: {} },
      syncedAt: 1,
    });
    google.people = { status: 403, body: '{"error":{"details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}' };
    const session = sessionFor("desktop", memoryTokens(signedIn(ALL_SCOPES)).store, { contacts: contacts.store }).session;

    expect(await session.refreshContacts()).toBeNull();
    expect(contacts.saved()).toBeNull();
  });

  it("is erased on sign-out with the mail", async () => {
    const contacts = memoryContacts();
    await contacts.store.write({ version: 3, saved: { people: {} }, other: { people: {} }, syncedAt: 1 });
    const session = sessionFor("desktop", memoryTokens(signedIn(ALL_SCOPES)).store, { contacts: contacts.store }).session;
    await session.signOut();
    expect(contacts.saved()).toBeNull();
  });
});

describe("grantContacts — web, finished by the redirect back", () => {
  function installBrowser(search: string): { replaced: string[] } {
    const backing = new Map<string, string>();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => backing.get(k) ?? null,
        setItem: (k: string, v: string) => void backing.set(k, v),
        removeItem: (k: string) => void backing.delete(k),
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { search, pathname: "/", hash: "", origin: "https://app.example" },
    });
    const replaced: string[] = [];
    Object.defineProperty(globalThis, "history", {
      configurable: true,
      value: { replaceState: (_: unknown, __: string, url: string) => void replaced.push(url) },
    });
    return { replaced };
  }

  beforeEach(() => {
    storedClient = { clientId: "web.apps.googleusercontent.com", clientSecret: "web-secret" };
  });

  it("navigates to Google with the same incremental-consent request", async () => {
    installBrowser("");
    const { session, opened } = sessionFor("web", memoryTokens(signedIn()).store);
    void session.grantContacts();
    for (let i = 0; i < 50 && opened.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));
    const query = new URL(opened[0]).searchParams;
    expect(query.get("include_granted_scopes")).toBe("true");
    // The app's own address: what the setup screen tells the user to register.
    expect(query.get("redirect_uri")).toBe("https://app.example/");
    expect(query.get("scope")).toContain(OTHER_CONTACTS_SCOPE);
  });

  it("comes back granted, with the code scrubbed from the address bar", async () => {
    const { replaced } = installBrowser("?code=abc&state=st-1");
    rememberPendingAuth({
      state: "st-1",
      verifier: "v",
      redirectUri: "https://app.example/auth/callback",
      purpose: "contacts",
      expectEmail: "me@example.com",
    });
    const session = sessionFor("web", memoryTokens(signedIn()).store).session;
    const completed = await session.completeWebRedirect();
    expect(completed).toMatchObject({ email: "me@example.com", contacts: "granted" });
    expect(replaced).toEqual(["/"]);
  });

  it("treats a declined opt-in as the same session, not a failed sign-in", async () => {
    installBrowser("?error=access_denied&state=st-2");
    rememberPendingAuth({ state: "st-2", verifier: "v", redirectUri: "https://app.example/auth/callback", purpose: "contacts" });
    const before = signedIn();
    const tokens = memoryTokens(before);
    const session = sessionFor("web", tokens.store).session;

    const completed = await session.completeWebRedirect();

    expect(completed?.contacts).toBe("declined");
    expect(completed?.email).toBe("me@example.com");
    expect(completed?.contactsMessage).toMatch(/not connected/i);
    expect(tokens.current()).toEqual(before);
  });

  it("still throws for a declined sign-in", async () => {
    installBrowser("?error=access_denied&state=st-3");
    rememberPendingAuth({ state: "st-3", verifier: "v", redirectUri: "https://app.example/auth/callback" });
    const session = sessionFor("web", memoryTokens(null).store).session;
    await expect(session.completeWebRedirect()).rejects.toMatchObject({ kind: "declined" });
  });

  it("puts the old tokens back when the opt-in came back for another account", async () => {
    installBrowser("?code=abc&state=st-4");
    google.profiles = ["intruder@example.com"];
    rememberPendingAuth({
      state: "st-4",
      verifier: "v",
      redirectUri: "https://app.example/auth/callback",
      purpose: "contacts",
      expectEmail: "me@example.com",
    });
    const before = signedIn();
    const tokens = memoryTokens(before);
    const session = sessionFor("web", tokens.store).session;

    const completed = await session.completeWebRedirect();

    expect(completed).toMatchObject({ email: "me@example.com", contacts: "declined" });
    expect(completed?.contactsMessage).toContain("intruder@example.com");
    expect(tokens.current()).toEqual(before);
  });
});

describe("the account's own profile picture (STRM-461)", () => {
  it("reads the profile grant off the stored token", async () => {
    expect(await sessionFor("desktop", memoryTokens(null).store).session.profileAccess()).toBe("unavailable");
    expect(await sessionFor("desktop", memoryTokens(signedIn()).store).session.profileAccess()).toBe("not_granted");
    expect(await sessionFor("desktop", memoryTokens(signedIn(SIGN_IN_SCOPE)).store).session.profileAccess()).toBe("granted");
  });

  it("does not ask Google for the picture when the grant is known to lack the scope", async () => {
    const session = sessionFor("desktop", memoryTokens(signedIn()).store).session;
    expect(await session.ownProfile()).toEqual({ kind: "not_granted" });
    expect(google.requests.some((url) => url.includes("userinfo"))).toBe(false);
  });

  it("reads the picture from userinfo once the grant has it", async () => {
    const session = sessionFor("desktop", memoryTokens(signedIn(SIGN_IN_SCOPE)).store).session;
    expect(await session.ownProfile()).toEqual({ kind: "ok", name: null, picture: "https://lh3.googleusercontent.com/a/me=s96-c" });
  });

  it("re-consents for the profile alone on top of the existing grant", async () => {
    google.grantedScope = SIGN_IN_SCOPE;
    const tokens = memoryTokens(signedIn());
    const { session, opened } = sessionFor("desktop", tokens.store);

    expect(await session.grantProfile()).toBe("granted");

    const query = new URL(opened[0]).searchParams;
    expect(query.get("scope")).toBe(PROFILE_SCOPE);
    expect(query.get("include_granted_scopes")).toBe("true");
    expect(query.get("login_hint")).toBe("me@example.com");
    expect(tokens.current()?.scope).toBe(SIGN_IN_SCOPE);
  });

  it("keeps the session exactly as it was when the user says no", async () => {
    const before = signedIn();
    const tokens = memoryTokens(before);
    const session = sessionFor("desktop", tokens.store, { outcome: "access_denied" }).session;

    const error = await session.grantProfile().catch((caught: unknown) => caught);

    expect((error as GmailError).kind).toBe("declined");
    expect((error as GmailError).message).toMatch(/profile picture was not allowed/i);
    expect(tokens.current()).toEqual(before);
  });
});

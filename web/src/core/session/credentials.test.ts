/**
 * The user's own OAuth client: validation, storage, removal, the connection test, and
 * the guarantee that no build-time client is read anywhere.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_ID_SUFFIX,
  WEB_CREDENTIALS_KEY,
  clientIdError,
  clientSecretError,
  hasErrors,
  localStorageCredentialStore,
  maskClientId,
  normaliseCredentials,
  parseStoredCredentials,
  testConnection,
  validateCredentials,
  webRedirectUriFor,
  type OAuthClientCredentials,
} from "./credentials";
import { GmailSession } from "./session";
import { GMAIL_SCOPE, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, GmailError, type TokenSet } from "../gmail/dto";
import { NO_CLIENT_MESSAGE, TokenManager, type TokenStore } from "../gmail/tokens";
import type { CursorStore, MailboxCache } from "../gmail/sync";
import type { Platform, PlatformInfo, SignInResult } from "../../platform/types";
import { demoMailbox } from "../data/demo";
import { WinnowStore } from "../store/store";

const ID = `1234567890-abc123def${CLIENT_ID_SUFFIX}`;

// ── Validation ───────────────────────────────────────────────────────────────

describe("clientIdError", () => {
  it("accepts a Google client id, with surrounding whitespace trimmed", () => {
    expect(clientIdError(ID)).toBeNull();
    expect(clientIdError(`  ${ID}\n`)).toBeNull();
  });

  it("asks for one when empty", () => {
    expect(clientIdError("")).toMatch(/Enter the client ID/);
    expect(clientIdError("   ")).toMatch(/Enter the client ID/);
  });

  it("names the suffix when it is missing", () => {
    expect(clientIdError("1234567890-abc123def")).toContain(CLIENT_ID_SUFFIX);
    expect(clientIdError("1234567890-abc.apps.google.com")).toContain(CLIENT_ID_SUFFIX);
  });

  it("spots a secret pasted into the id field", () => {
    expect(clientIdError("gocspx-not-a-real-one")).toMatch(/client secret/);
    expect(clientIdError("GOCSPX" + "-not-a-real-one")).toMatch(/client secret/);
  });

  it("refuses spaces and a bare suffix", () => {
    expect(clientIdError(`123 456${CLIENT_ID_SUFFIX}`)).toMatch(/no spaces/);
    expect(clientIdError(CLIENT_ID_SUFFIX)).not.toBeNull();
    expect(clientIdError(`-x${CLIENT_ID_SUFFIX}`)).not.toBeNull();
  });
});

describe("clientSecretError", () => {
  it("is optional for a Desktop app client", () => {
    expect(clientSecretError("", "desktop")).toBeNull();
    expect(clientSecretError(undefined, "desktop")).toBeNull();
  });

  it("is required for a Web application client", () => {
    expect(clientSecretError("", "web")).toMatch(/needs its client secret/);
    expect(clientSecretError("some-secret", "web")).toBeNull();
  });

  it("spots the client id pasted into the secret field", () => {
    expect(clientSecretError(ID, "desktop")).toMatch(/client ID/);
  });

  it("refuses spaces", () => {
    expect(clientSecretError("abc def", "desktop")).toMatch(/no spaces/);
  });
});

describe("validateCredentials", () => {
  it("returns no errors for a valid pair", () => {
    expect(hasErrors(validateCredentials({ clientId: ID, clientSecret: "s" }, "web"))).toBe(false);
    expect(hasErrors(validateCredentials({ clientId: ID }, "desktop"))).toBe(false);
  });

  it("reports both fields at once", () => {
    const errors = validateCredentials({ clientId: "nope", clientSecret: "" }, "web");
    expect(errors.clientId).toBeTruthy();
    expect(errors.clientSecret).toBeTruthy();
    expect(hasErrors(errors)).toBe(true);
  });
});

describe("normaliseCredentials / parseStoredCredentials", () => {
  it("trims, and drops an empty secret", () => {
    expect(normaliseCredentials({ clientId: ` ${ID} `, clientSecret: "  " })).toEqual({ clientId: ID });
    expect(normaliseCredentials({ clientId: ID, clientSecret: " s " })).toEqual({ clientId: ID, clientSecret: "s" });
  });

  it("refuses anything that is not a stored pair with a valid id", () => {
    expect(parseStoredCredentials(null)).toBeNull();
    expect(parseStoredCredentials("")).toBeNull();
    expect(parseStoredCredentials("{oops")).toBeNull();
    expect(parseStoredCredentials(JSON.stringify({ clientId: "nope" }))).toBeNull();
    expect(parseStoredCredentials(JSON.stringify({ clientSecret: "s" }))).toBeNull();
    expect(parseStoredCredentials(JSON.stringify({ clientId: ID, clientSecret: 5 }))).toEqual({ clientId: ID });
  });
});

describe("maskClientId", () => {
  it("keeps enough to recognise", () => {
    expect(maskClientId(ID)).toBe(`123456…3def${CLIENT_ID_SUFFIX}`);
    expect(maskClientId(`short${CLIENT_ID_SUFFIX}`)).toBe(`short${CLIENT_ID_SUFFIX}`);
  });
});

describe("webRedirectUriFor", () => {
  it("is the app's own address, without index.html", () => {
    expect(webRedirectUriFor({ origin: "https://mail.example", pathname: "/" })).toBe("https://mail.example/");
    expect(webRedirectUriFor({ origin: "https://x.example", pathname: "/winnow/index.html" })).toBe(
      "https://x.example/winnow/",
    );
  });

  it("is empty with no usable origin", () => {
    expect(webRedirectUriFor(undefined)).toBe("");
    expect(webRedirectUriFor({ origin: "null", pathname: "/" })).toBe("");
  });
});

// ── Storage and removal ──────────────────────────────────────────────────────

function installLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    },
  });
  return backing;
}

describe("localStorageCredentialStore", () => {
  afterEach(() => Reflect.deleteProperty(globalThis, "localStorage"));

  it("writes, reads back and clears under one key", async () => {
    const backing = installLocalStorage();
    const store = localStorageCredentialStore();
    expect(await store.read()).toBeNull();

    await store.write({ clientId: ` ${ID}`, clientSecret: "web-secret" });
    expect([...backing.keys()]).toEqual([WEB_CREDENTIALS_KEY]);
    expect(await store.read()).toEqual({ clientId: ID, clientSecret: "web-secret" });

    await store.clear();
    expect(backing.size).toBe(0);
    expect(await store.read()).toBeNull();
  });

  it("reads nothing when storage throws, and says so when a write cannot land", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("denied");
        },
        removeItem: () => {
          throw new Error("denied");
        },
      },
    });
    const store = localStorageCredentialStore();
    expect(await store.read()).toBeNull();
    await expect(store.clear()).resolves.toBeUndefined();

    Reflect.deleteProperty(globalThis, "localStorage");
    await expect(store.write({ clientId: ID })).rejects.toThrow(/cannot be saved/);
  });
});

// ── The connection test ──────────────────────────────────────────────────────

type Seen = { url: string; body: URLSearchParams };

function google(status: number, payload: unknown, seen: Seen[] = []) {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("testConnection", () => {
  const redirect = "http://127.0.0.1:1/winnow-oauth";

  it("passes when Google only refuses the made-up code", async () => {
    const { fetchImpl, seen } = google(400, { error: "invalid_grant", error_description: "Malformed auth code." });
    const result = await testConnection({ clientId: ID }, redirect, fetchImpl);
    expect(result.ok).toBe(true);
    // To Google's token endpoint and nowhere else, with no secret when none was given.
    expect(seen.map((s) => s.url)).toEqual([GOOGLE_TOKEN_URL]);
    expect(seen[0].body.get("client_id")).toBe(ID);
    expect(seen[0].body.get("client_secret")).toBeNull();
  });

  it("sends the secret when there is one", async () => {
    const { fetchImpl, seen } = google(400, { error: "invalid_grant" });
    await testConnection({ clientId: ID, clientSecret: "s3" }, redirect, fetchImpl);
    expect(seen[0].body.get("client_secret")).toBe("s3");
  });

  it("blames the id when Google has never heard of the client", async () => {
    const { fetchImpl } = google(401, { error: "invalid_client", error_description: "The OAuth client was not found." });
    expect(await testConnection({ clientId: ID }, redirect, fetchImpl)).toMatchObject({ ok: false, field: "clientId" });
  });

  it("blames the secret when the client exists but is refused", async () => {
    const { fetchImpl } = google(401, { error: "invalid_client", error_description: "Unauthorized" });
    const result = await testConnection({ clientId: ID, clientSecret: "wrong" }, redirect, fetchImpl);
    expect(result).toMatchObject({ ok: false, field: "clientSecret" });
    expect(result.message).toMatch(/rejected the client secret/);
  });

  it("asks for the secret when Google says it is missing", async () => {
    const { fetchImpl } = google(400, { error: "invalid_request", error_description: "client_secret is missing." });
    expect(await testConnection({ clientId: ID }, redirect, fetchImpl)).toMatchObject({ ok: false, field: "clientSecret" });
  });

  it("reports a network failure without a field", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const result = await testConnection({ clientId: ID }, redirect, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("field");
    expect(result.message).toMatch(/offline/);
  });
});

// ── The session: setup, change, removal, and no client at all ────────────────

function infoFor(kind: "desktop" | "web"): PlatformInfo {
  return {
    name: "Winnow",
    version: "0.0.0",
    os: "test",
    arch: "test",
    kind,
    nativeOAuth: kind === "desktop",
    nativeSecrets: kind === "desktop",
    backgroundSync: true,
    saveFiles: false,
  };
}

function harness(initial: OAuthClientCredentials | null, tokens: TokenSet | null = null) {
  let client = initial;
  let stored = tokens;
  const opened: string[] = [];
  const cleared = { tokens: 0, cache: 0 };
  const tokenStore: TokenStore = {
    read: async () => stored,
    write: async (next) => void (stored = next),
    clear: async () => {
      cleared.tokens += 1;
      stored = null;
    },
  };
  const platform = {
    info: async () => infoFor("desktop"),
    tokenStore: () => tokenStore,
    credentialStore: () => ({
      read: async () => client,
      write: async (next: OAuthClientCredentials) => void (client = next),
      clear: async () => void (client = null),
    }),
    async beginSignIn(request: { authorizeUrl: string }): Promise<SignInResult> {
      opened.push(request.authorizeUrl);
      return { kind: "cancelled" };
    },
    cancelSignIn: async () => {},
  } as unknown as Platform;
  const cache = {
    all: async () => [],
    clear: async () => void (cleared.cache += 1),
  } as unknown as MailboxCache & CursorStore;
  const contacts = { read: async () => null, write: async () => {}, clear: async () => {} };
  const session = new GmailSession(platform, cache, contacts as never);
  return { session, opened, cleared, client: () => client, tokens: () => stored };
}

const SESSION: TokenSet = { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, scope: GMAIL_SCOPE };

let revoked: string[] = [];

describe("GmailSession with the user's own client", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    revoked = [];
    // A sign-out revokes the grant: recorded here, never sent.
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url) === GOOGLE_REVOKE_URL) revoked.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
      return new Response("{}", { status: 200 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "sessionStorage");
  });

  it("refuses to sign in before setup, and opens nothing", async () => {
    const { session, opened } = harness(null);
    const error = await session.signIn().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GmailError);
    expect((error as GmailError).kind).toBe("config");
    expect((error as GmailError).message).toBe(NO_CLIENT_MESSAGE);
    expect(opened).toEqual([]);
  });

  it("puts the stored client id in the authorize URL", async () => {
    const { session, opened } = harness({ clientId: ID });
    await session.signIn().catch(() => undefined);
    expect(new URL(opened[0]).searchParams.get("client_id")).toBe(ID);
  });

  it("saving a first client signs nobody out", async () => {
    const { session, cleared, client } = harness(null);
    expect(await session.saveCredentials({ clientId: ID })).toEqual({ signedOut: false });
    expect(client()).toEqual({ clientId: ID });
    expect(cleared.tokens).toBe(0);
  });

  it("changing the client signs out the session made with the old one", async () => {
    const { session, cleared, tokens } = harness({ clientId: ID }, SESSION);
    const other = `999-zzz${CLIENT_ID_SUFFIX}`;
    expect(await session.saveCredentials({ clientId: other })).toEqual({ signedOut: true });
    expect(tokens()).toBeNull();
    expect(cleared.cache).toBe(1);
    // The old client's grant is ended at Google too, once.
    expect(revoked).toEqual([SESSION.refreshToken]);
  });

  it("saving the same client again keeps the session", async () => {
    const { session, tokens } = harness({ clientId: ID }, SESSION);
    expect(await session.saveCredentials({ clientId: ID })).toEqual({ signedOut: false });
    expect(tokens()).not.toBeNull();
    expect(revoked).toEqual([]);
  });

  it("removing the client signs out, wipes the cache and forgets the client", async () => {
    const { session, cleared, client, tokens } = harness({ clientId: ID, clientSecret: "s" }, SESSION);
    expect(await session.removeCredentials()).toEqual({ signedOut: true });
    expect(client()).toBeNull();
    expect(tokens()).toBeNull();
    expect(cleared.cache).toBe(1);
    expect(await session.hasSession()).toBe(false);
  });

  it("removing it with nobody signed in reports no sign-out", async () => {
    const { session, client } = harness({ clientId: ID });
    expect(await session.removeCredentials()).toEqual({ signedOut: false });
    expect(client()).toBeNull();
  });
});

describe("TokenManager with a client resolver", () => {
  it("sends the user's secret when there is one, and none when there is not", async () => {
    const seen: URLSearchParams[] = [];
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      seen.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600, refresh_token: "r" }), { status: 200 });
    }) as unknown as typeof fetch;
    let client: OAuthClientCredentials | null = { clientId: ID, clientSecret: "desk-secret" };
    const store: TokenStore = { read: async () => null, write: async () => {}, clear: async () => {} };
    const manager = new TokenManager({ store, client: async () => client, fetchImpl });

    await manager.exchangeCode({ code: "c", verifier: "v", redirectUri: "http://127.0.0.1:1/winnow-oauth" });
    expect(seen[0].get("client_id")).toBe(ID);
    expect(seen[0].get("client_secret")).toBe("desk-secret");

    client = { clientId: ID };
    await manager.exchangeCode({ code: "c", verifier: "v", redirectUri: "http://127.0.0.1:1/winnow-oauth" });
    expect(seen[1].get("client_secret")).toBeNull();
  });

  it("fails as a config error, without calling Google, once the client is removed", async () => {
    const fetchImpl = vi.fn();
    const store: TokenStore = { read: async () => null, write: async () => {}, clear: async () => {} };
    const manager = new TokenManager({ store, client: async () => null, fetchImpl: fetchImpl as never });
    await expect(
      manager.exchangeCode({ code: "c", verifier: "v", redirectUri: "x" }),
    ).rejects.toMatchObject({ kind: "config" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ── The demo needs nothing ───────────────────────────────────────────────────

describe("the demo mailbox with no credentials", () => {
  it("is a full mailbox with no client, no session and no network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { session } = harness(null);
    expect(await session.storedCredentials()).toBeNull();
    expect(await session.hasSession()).toBe(false);

    const demo = demoMailbox();
    const store = new WinnowStore({ seed: demo.emails, now: demo.now });
    expect(store.getSnapshot().all.length).toBeGreaterThan(0);
    expect(store.getSnapshot().account).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ── No client is baked into a build ──────────────────────────────────────────

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const REPO = path.resolve(WEB, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

describe("no build-time Google client", () => {
  it("is read anywhere in the app's source", () => {
    const offenders = sources(path.join(WEB, "src")).filter((file) =>
      /VITE_GMAIL_|GMAIL_CLIENT_ID|GMAIL_CLIENT_SECRET/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("is passed to any build by the workflows or the Vite config", () => {
    for (const file of [
      path.join(REPO, ".github/workflows/release.yml"),
      path.join(REPO, ".github/workflows/ci.yml"),
      path.join(WEB, "vite.config.ts"),
    ]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/VITE_GMAIL_|secrets\.[A-Z_]*GMAIL/);
    }
  });

  it("keeps the release guard against a bundled client secret", () => {
    const release = readFileSync(path.join(REPO, ".github/workflows/release.yml"), "utf8");
    expect(release).toContain("grep -rIl 'GOCSPX-' web/dist");
  });
});

/**
 * Sign-out through the session and the bridge revokes the grant exactly once.
 *
 * The token-level contract is in `gmail/revoke.test.ts`; these cover the wiring: the
 * UI's one sign-out reaches Google once, not once per layer, the demo reaches it never,
 * and the mail is gone from disk before Google has answered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionBridge } from "./bridge";
import { GmailSession, localCache } from "./session";
import { GOOGLE_REVOKE_URL, type TokenSet } from "../gmail/dto";
import type { TokenStore } from "../gmail/tokens";
import type { Platform } from "../../platform/types";
import type { WinnowStore } from "../store/store";

const REFRESH = ["fake", "refresh", "for", "tests"].join("-");

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

function memoryTokens(initial: TokenSet | null) {
  let current = initial;
  const store: TokenStore = {
    read: async () => current,
    write: async (tokens) => void (current = tokens),
    clear: async () => void (current = null),
  };
  return { store, peek: () => current };
}

function platform(tokens: TokenStore): Platform {
  return {
    tokenStore: () => tokens,
    credentialStore: () => ({ read: async () => ({ clientId: "id" }), write: async () => {}, clear: async () => {} }),
  } as unknown as Platform;
}

const contacts = () => ({ read: async () => null, write: async () => {}, clear: async () => {} });

let storage: Map<string, string>;
let requests: { url: string; body: string }[];
let answer: () => Promise<Response>;

beforeEach(() => {
  storage = installLocalStorage();
  requests = [];
  answer = async () => new Response("{}", { status: 200 });
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    requests.push({ url: String(input), body: String(init?.body ?? "") });
    return answer();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "localStorage");
});

const revokes = () => requests.filter((r) => r.url === GOOGLE_REVOKE_URL);
const signedIn = (): TokenSet => ({ accessToken: "a", refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000 });

describe("signing out through the bridge", () => {
  it("revokes exactly once, with the refresh token in the body", async () => {
    const tokens = memoryTokens(signedIn());
    const store = { signOut: vi.fn(async () => {}) } as unknown as WinnowStore;
    const bridge = createSessionBridge(platform(tokens.store), store);
    expect(await bridge.hasSession()).toBe(true);

    await bridge.signOut();
    await vi.waitFor(() => expect(revokes()).toHaveLength(1));
    expect(new URLSearchParams(revokes()[0].body).get("token")).toBe(REFRESH);
    expect(revokes()[0].url).not.toContain(REFRESH);
    expect(tokens.peek()).toBeNull();
    expect(store.signOut).toHaveBeenCalledTimes(1);

    // Pressing it again revokes nothing more.
    await bridge.signOut();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(revokes()).toHaveLength(1);
  });

  it("revokes nothing for the demo", async () => {
    const tokens = memoryTokens(signedIn());
    const bridge = createSessionBridge(platform(tokens.store), { signOut: async () => {} } as unknown as WinnowStore);
    await bridge.signOut({ revoke: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(0);
    expect(tokens.peek()).toBeNull();
  });

  it("revokes nothing when there is no session at all", async () => {
    const bridge = createSessionBridge(platform(memoryTokens(null).store), { signOut: async () => {} } as unknown as WinnowStore);
    await bridge.signOut();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(0);
  });
});

describe("GmailSession.signOut", () => {
  it("has erased the mail before a hanging revoke answers", async () => {
    answer = () => new Promise<Response>(() => {});
    const tokens = memoryTokens(signedIn());
    const session = new GmailSession(platform(tokens.store), localCache(), contacts());
    storage.set("winnow.gmail.cache.messages", "[]");

    await session.signOut();
    expect(revokes()).toHaveLength(1);
    expect(tokens.peek()).toBeNull();
    expect(storage.has("winnow.gmail.cache.messages")).toBe(false);
    expect(await session.hasSession()).toBe(false);
  });

  it("signs out when the revoke fails", async () => {
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    const tokens = memoryTokens(signedIn());
    const session = new GmailSession(platform(tokens.store), localCache(), contacts());
    await expect(session.signOut()).resolves.toBeUndefined();
    expect(await session.tokens.revocation).toBe("failed");
    expect(tokens.peek()).toBeNull();
  });
});

/**
 * The account's own Google picture through the bridge (STRM-461): a session from before
 * sign-in asked for the basic profile gets the one-time prompt and nothing else, and a
 * picture's halo colour is worked out once and kept with the account.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionBridge } from "./bridge";
import { loadAccounts, saveAccounts, webTokenKey } from "./accounts";
import { localStorageTokenStore } from "../gmail/tokens";
import { GMAIL_SCOPE, SIGN_IN_SCOPE, type TokenSet } from "../gmail/dto";
import { WinnowStore } from "../store/store";
import type { Platform } from "../../platform/types";

const A = "aaaa1111";
const PICTURE = "https://lh3.googleusercontent.com/a/me=s96-c";

function installLocalStorage(): void {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
    },
  });
}

function platform(): Platform {
  const credentials = { clientId: "1234567890-abc123def.apps.googleusercontent.com" };
  return {
    info: async () => ({ kind: "desktop", os: "linux", nativeOAuth: true, nativeSecrets: true, backgroundSync: true, saveFiles: true, version: "1.7.1", name: "winnow" }),
    tokenStore: (account?: string) => (account ? localStorageTokenStore(webTokenKey(account)) : localStorageTokenStore()),
    credentialStore: () => ({ read: async () => credentials, write: async () => {}, clear: async () => {} }),
    beginSignIn: async () => ({ kind: "cancelled" }),
    cancelSignIn: async () => {},
  } as unknown as Platform;
}

let userinfoCalls = 0;

beforeEach(() => {
  installLocalStorage();
  userinfoCalls = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://www.googleapis.com/oauth2/v3/userinfo")) {
      userinfoCalls += 1;
      return json({ picture: "https://lh3.googleusercontent.com/a/me=s100" });
    }
    if (url.includes("/profile")) return json({ emailAddress: "ada@one.example", historyId: "100", messagesTotal: 0 });
    if (url.includes("/history")) return json({ historyId: "100" });
    if (url.includes("/messages")) return json({ resultSizeEstimate: 0 });
    return json({});
  });
});
afterEach(() => vi.unstubAllGlobals());

async function seed(scope: string): Promise<void> {
  saveAccounts(globalThis.localStorage, {
    version: 1,
    active: A,
    accounts: [{ id: A, email: "ada@one.example", color: "space", notify: true, addedAt: 1 }],
  });
  await localStorageTokenStore(webTokenKey(A)).write({
    accessToken: "access-a",
    refreshToken: "1//refresh-a",
    expiresAt: Date.now() + 3_600_000,
    scope,
  } as TokenSet);
}

describe("an account signed in before Winnow asked for the basic profile", () => {
  it("keeps its monogram, gets the one-time prompt, and never asks Google by itself", async () => {
    await seed(GMAIL_SCOPE);
    const store = new WinnowStore();
    const bridge = createSessionBridge(platform(), store, { storage: globalThis.localStorage, pictureColor: async () => "#1E5AC8" });
    await bridge.prepare();
    await bridge.accounts.openActive();

    await vi.waitFor(() => expect(store.getSnapshot().accounts.find((a) => a.active)?.profilePrompt).toBe(true));
    const summary = store.getSnapshot().accounts.find((a) => a.active)!;
    expect(summary.picture).toBeUndefined();
    expect(summary.pictureColor).toBeUndefined();
    expect(userinfoCalls).toBe(0);

    // "Not now": gone for good for this account, with no setting anywhere.
    bridge.dismissProfilePrompt();
    await vi.waitFor(() => expect(store.getSnapshot().accounts.find((a) => a.active)?.profilePrompt).toBeUndefined());
    expect(loadAccounts(globalThis.localStorage).accounts[0]?.profile).toMatchObject({ access: "not_granted", prompted: true });
  });
});

describe("the halo colour", () => {
  it("is worked out once per picture and kept with the account", async () => {
    await seed(SIGN_IN_SCOPE);
    const sampler = vi.fn(async () => "#1E5AC8");
    const store = new WinnowStore();
    const bridge = createSessionBridge(platform(), store, { storage: globalThis.localStorage, pictureColor: sampler });
    await bridge.prepare();
    await bridge.accounts.openActive();

    await vi.waitFor(() => expect(store.getSnapshot().accounts.find((a) => a.active)?.pictureColor).toBe("#1E5AC8"));
    expect(store.getSnapshot().accounts.find((a) => a.active)?.picture).toBe(PICTURE);
    expect(store.getSnapshot().accounts.find((a) => a.active)?.profilePrompt).toBeUndefined();
    expect(loadAccounts(globalThis.localStorage).accounts[0]?.profile).toMatchObject({ access: "granted", picture: PICTURE, color: "#1E5AC8" });
    expect(sampler).toHaveBeenCalledTimes(1);

    // Read again (the same picture): the kept colour is used, not sampled again.
    await bridge.refreshOwnProfile();
    expect(userinfoCalls).toBe(2);
    expect(sampler).toHaveBeenCalledTimes(1);
  });

  it("is left to the account colour when the picture has none", async () => {
    await seed(SIGN_IN_SCOPE);
    const store = new WinnowStore();
    const bridge = createSessionBridge(platform(), store, { storage: globalThis.localStorage, pictureColor: async () => null });
    await bridge.prepare();
    await bridge.accounts.openActive();

    await vi.waitFor(() => expect(loadAccounts(globalThis.localStorage).accounts[0]?.profile).toMatchObject({ access: "granted", color: null }));
    expect(store.getSnapshot().accounts.find((a) => a.active)?.picture).toBe(PICTURE);
    expect(store.getSnapshot().accounts.find((a) => a.active)?.pictureColor).toBeUndefined();
  });
});

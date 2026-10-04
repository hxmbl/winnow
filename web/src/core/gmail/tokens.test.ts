import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPIRY_SLACK_MS,
  MIN_STORED_LIFETIME_MS,
  TokenManager,
  localStorageTokenStore,
  type TokenStore,
} from "./tokens";
import { GmailError, GOOGLE_TOKEN_URL, type TokenSet } from "./dto";
import { webTokenStore } from "../../platform/types";

/**
 * Poll until `condition` holds, so a test can wait for a request to be genuinely
 * in flight rather than racing the microtask queue.
 */
async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** An in-memory store, so the keychain is not part of what these tests check. */
function memoryStore(initial: TokenSet | null = null) {
  let value = initial;
  const writes: TokenSet[] = [];
  const store: TokenStore = {
    async read() {
      return value;
    },
    async write(tokens) {
      value = tokens;
      writes.push(tokens);
    },
    async clear() {
      value = null;
    },
  };
  return { store, writes, peek: () => value };
}

function tokenSet(over: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    // Comfortably in the future, so `validAccessToken` does not refresh.
    expiresAt: Date.now() + 3_600_000,
    ...over,
  };
}

/**
 * A `fetch` that answers the token endpoint, and counts how often it was asked.
 *
 * The counter is a named object rather than a property on the returned value,
 * because destructuring `{ fetchImpl, calls }` would read the counter once at
 * destructuring time and freeze it at zero.
 */
function tokenFetch(
  response: { status?: number; body?: unknown } = {},
  delayMs = 0,
): { fetchImpl: typeof fetch; count: () => number } {
  const state = { calls: 0 };
  const fetchImpl = vi.fn(async () => {
    state.calls += 1;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () =>
        response.body ?? { access_token: "access-2", expires_in: 3600, scope: "s" },
      text: async () => JSON.stringify(response.body ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, count: () => state.calls };
}

describe("TokenManager — reading the session", () => {
  it("reports no session when the store is empty", async () => {
    const manager = new TokenManager({
      store: memoryStore().store,
      clientId: "id",
      fetchImpl: tokenFetch().fetchImpl,
    });
    expect(await manager.hasSession()).toBe(false);
    expect(await manager.validAccessToken()).toBeNull();
  });

  it("reports a session when the store has one, even a stale one", async () => {
    // A stale token set still means "signed in, needs a refresh", which is a
    // different screen from "signed out".
    const stale = tokenSet({ expiresAt: Date.now() - 1_000_000 });
    const manager = new TokenManager({
      store: memoryStore(stale).store,
      clientId: "id",
      fetchImpl: tokenFetch().fetchImpl,
    });
    expect(await manager.hasSession()).toBe(true);
  });

  it("separates a store failure from an empty store", async () => {
    // Conflating them produced a sign-in screen that kept reappearing while the
    // real problem was a locked keychain.
    const broken: TokenStore = {
      async read() {
        throw new Error("keychain locked");
      },
      async write() {},
      async clear() {},
    };
    const manager = new TokenManager({
      store: broken,
      clientId: "id",
      fetchImpl: tokenFetch().fetchImpl,
    });
    expect(await manager.hasSession()).toBe(false);
    expect(await manager.storageError()).toBe("keychain locked");
  });
});

describe("TokenManager — refresh", () => {
  it("returns the cached token while it is comfortably valid", async () => {
    const { fetchImpl, count } = tokenFetch();
    const manager = new TokenManager({
      store: memoryStore(tokenSet()).store,
      clientId: "id",
      fetchImpl,
    });
    expect(await manager.validAccessToken()).toBe("access-1");
    expect(count()).toBe(0);
  });

  it("refreshes when inside the slack window", async () => {
    // Without the slack, a request could start with 100ms of validity left and
    // 401 on arrival — a self-inflicted reauth loop.
    const { fetchImpl, count } = tokenFetch();
    const manager = new TokenManager({
      store: memoryStore(tokenSet({ expiresAt: Date.now() + 1_000 })).store,
      clientId: "id",
      fetchImpl,
    });
    expect(await manager.validAccessToken()).toBe("access-2");
    expect(count()).toBe(1);
  });

  it("coalesces a burst of refreshes into one request", async () => {
    // A page of 200 messages arriving at once must not produce 200 token
    // requests — that is how a working session becomes a rate-limit problem.
    const { fetchImpl, count } = tokenFetch({}, 20);
    const manager = new TokenManager({
      store: memoryStore(tokenSet({ expiresAt: Date.now() - 1 })).store,
      clientId: "id",
      fetchImpl,
    });

    const tokens = await Promise.all(
      Array.from({ length: 50 }, () => manager.validAccessToken()),
    );

    expect(new Set(tokens).size).toBe(1);
    expect(count()).toBe(1);
  });

  it("keeps the refresh token across a refresh", async () => {
    // Google's refresh response omits it; it has not changed.
    const store = memoryStore(tokenSet({ expiresAt: Date.now() - 1 }));
    const manager = new TokenManager({
      store: store.store,
      clientId: "id",
      fetchImpl: tokenFetch().fetchImpl,
    });
    await manager.validAccessToken();
    expect(store.peek()?.refreshToken).toBe("refresh-1");
  });

  it("floors the stored lifetime, so a tiny expires_in cannot loop", async () => {
    // A pathological `expires_in` of 30 would put the token inside the slack
    // window immediately, so *every* call would refresh.
    const { fetchImpl } = tokenFetch({ body: { access_token: "a2", expires_in: 30 } });
    const store = memoryStore(tokenSet({ expiresAt: Date.now() - 1 }));
    const manager = new TokenManager({ store: store.store, clientId: "id", fetchImpl });

    await manager.validAccessToken();
    expect(store.peek()!.expiresAt - Date.now()).toBeGreaterThan(MIN_STORED_LIFETIME_MS - 1_000);

    // And the next call reuses it rather than refreshing again.
    const second = await manager.validAccessToken();
    expect(second).toBe("a2");
  });
});

describe("TokenManager — failure handling", () => {
  it("clears the session on invalid_grant and demands re-auth", async () => {
    // `invalid_grant` means the refresh token is revoked, the password changed,
    // or the scope changed. Retrying cannot fix any of those, and keeping the
    // token set would keep the app presenting a signed-in UI that cannot work.
    const { fetchImpl } = tokenFetch({ status: 400, body: { error: "invalid_grant" } });
    const store = memoryStore(tokenSet({ expiresAt: Date.now() - 1 }));
    const manager = new TokenManager({ store: store.store, clientId: "id", fetchImpl });

    await expect(manager.validAccessToken()).rejects.toMatchObject({
      kind: "reauth_required",
    });
    expect(store.peek()).toBeNull();
  });

  it("does not clear the session on a 500", async () => {
    // A server error is transient. Wiping the session on one turns a momentary
    // outage into a re-authentication.
    const { fetchImpl } = tokenFetch({ status: 500, body: { error: "backend_error" } });
    const store = memoryStore(tokenSet({ expiresAt: Date.now() - 1 }));
    const manager = new TokenManager({ store: store.store, clientId: "id", fetchImpl });

    await expect(manager.validAccessToken()).rejects.not.toMatchObject({ kind: "reauth_required" });
    expect(store.peek()).not.toBeNull();
  });

  it("blames the build, not the session, on invalid_client", async () => {
    // A wrong client secret is a build misconfiguration. Clearing the session
    // would force a re-authorisation that fails in exactly the same way — and
    // would take a working session down with it.
    const { fetchImpl } = tokenFetch({
      status: 401,
      body: { error: "invalid_client", error_description: "Unauthorized" },
    });
    const store = memoryStore(tokenSet({ expiresAt: Date.now() - 1 }));
    const manager = new TokenManager({
      store: store.store,
      clientId: "id",
      clientSecret: "wrong",
      fetchImpl,
    });

    await expect(manager.validAccessToken()).rejects.toMatchObject({
      kind: "invalid_client",
    });
    expect(store.peek()).not.toBeNull();
  });

  it("names invalid_client at the exchange too, not just the refresh", async () => {
    // Google answers the same way for both, and the wording must not drift: the
    // code exchange is where a web build with no secret actually fails.
    const { fetchImpl } = tokenFetch({
      status: 401,
      body: { error: "invalid_client" },
    });
    const manager = new TokenManager({ store: memoryStore(null).store, clientId: "id", fetchImpl });

    await expect(
      manager.exchangeCode({ code: "c", verifier: "v", redirectUri: "https://x/cb" }),
    ).rejects.toMatchObject({ kind: "invalid_client" });
  });

  it("does not leak Google's wording for a rejected code", async () => {
    // `invalid_grant` covers a replayed code as well as a misused one. Echoing
    // Google's description back would tell an attacker which half to fix.
    const { fetchImpl } = tokenFetch({
      status: 400,
      body: { error: "invalid_grant", error_description: "code already used" },
    });
    const manager = new TokenManager({ store: memoryStore(null).store, clientId: "id", fetchImpl });

    await expect(
      manager.exchangeCode({ code: "c", verifier: "v", redirectUri: "https://x/cb" }),
    ).rejects.toThrow(/^Sign-in could not be verified/);
  });

  it("reports a network failure distinctly", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const manager = new TokenManager({
      store: memoryStore(tokenSet({ expiresAt: Date.now() - 1 })).store,
      clientId: "id",
      fetchImpl,
    });
    await expect(manager.validAccessToken()).rejects.toMatchObject({ kind: "network" });
  });

  it("fails cleanly when there is no refresh token to use", async () => {
    // A token set with no refresh token can never be refreshed, so the session
    // is over regardless of what the access token's expiry says.
    const store = memoryStore(tokenSet({ expiresAt: Date.now() - 1, refreshToken: undefined }));
    const manager = new TokenManager({
      store: store.store,
      clientId: "id",
      fetchImpl: tokenFetch().fetchImpl,
    });
    await expect(manager.validAccessToken()).rejects.toMatchObject({ kind: "reauth_required" });
  });
});

describe("TokenManager — sign-out races", () => {
  it("does not resurrect a session the user just signed out of", async () => {
    // The race: the keychain read is genuinely async, so `validAccessToken`
    // can be mid-read when the user signs out. Without a generation check the
    // read resolves *after* `clear()` and puts the tokens straight back,
    // leaving a session that looks signed out and is not.
    const { fetchImpl } = tokenFetch({}, 40);
    const store = memoryStore(tokenSet({ expiresAt: Date.now() - 1 }));
    const manager = new TokenManager({ store: store.store, clientId: "id", fetchImpl });

    const inflight = manager.validAccessToken();
    await manager.clear();

    // Either outcome is acceptable — rejecting, or reporting no session — but
    // *resolving with a usable token* is not.
    const outcome = await inflight.then(
      (token) => ({ kind: "token" as const, token }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    expect(outcome.kind === "token" && outcome.token !== null).toBe(false);

    // And nothing was written back to the store.
    expect(store.peek()).toBeNull();
    expect(store.writes).toHaveLength(0);
    expect(await manager.hasSession()).toBe(false);
  });

  it("discards a refresh that completes after sign-out", async () => {
    // The same race one step later: the read has already landed, so a refresh is
    // genuinely in flight. Its result belongs to a session that no longer
    // exists, and must not be handed out or written back.
    const { fetchImpl, count } = tokenFetch({}, 40);
    const store = memoryStore(tokenSet({ expiresAt: Date.now() - 1 }));
    const manager = new TokenManager({ store: store.store, clientId: "id", fetchImpl });

    await manager.hasSession();
    const inflight = manager.validAccessToken();
    // Wait until the request is genuinely on the wire, or the test would be
    // racing the microtask queue rather than the thing it is named for.
    await waitFor(() => count() === 1);
    await manager.clear();

    await expect(inflight).rejects.toMatchObject({ kind: "reauth_required" });
    expect(store.peek()).toBeNull();
    expect(store.writes).toHaveLength(0);
  });

  it("does not let a stale refresh clear a newer session", async () => {
    // The mirror image: a refresh started under the old session must not wipe
    // the session that replaced it.
    const { fetchImpl, count } = tokenFetch({}, 40);
    const store = memoryStore(tokenSet({ expiresAt: Date.now() - 1 }));
    const manager = new TokenManager({ store: store.store, clientId: "id", fetchImpl });

    await manager.hasSession();
    const inflight = manager.validAccessToken();
    await waitFor(() => count() === 1);
    await manager.adopt(tokenSet({ accessToken: "fresh-session" }));

    await expect(inflight).rejects.toBeInstanceOf(GmailError);
    // The new session survived.
    expect(store.peek()?.accessToken).toBe("fresh-session");
  });

  it("serves the new token directly when a session is replaced before the refresh starts", async () => {
    // Timing out of `validAccessToken` is itself a race: it awaits the store
    // read, so a session adopted in that window is picked up without a wasted
    // round trip. Worth pinning, because "avoid the request" is the win here.
    const { fetchImpl, count } = tokenFetch({}, 40);
    const store = memoryStore(tokenSet({ expiresAt: Date.now() - 1 }));
    const manager = new TokenManager({ store: store.store, clientId: "id", fetchImpl });

    const inflight = manager.validAccessToken();
    await manager.adopt(tokenSet({ accessToken: "fresh-session" }));

    expect(await inflight).toBe("fresh-session");
    // No request was needed: the token it was going to fetch is already here.
    expect(count()).toBe(0);
  });
});

describe("TokenManager — the code exchange", () => {
  it("sends the verifier and stores what comes back", async () => {
    const seen: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      seen.push(new URLSearchParams(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const manager = new TokenManager({ store: memoryStore().store, clientId: "cid", fetchImpl });
    await manager.exchangeCode({ code: "the-code", verifier: "the-verifier", redirectUri: "http://x" });

    expect(seen[0].get("code_verifier")).toBe("the-verifier");
    expect(seen[0].get("grant_type")).toBe("authorization_code");
    expect((await manager.current())?.refreshToken).toBe("r");
  });

  it("never sends a client secret it was not given", async () => {
    // A secret baked into a bundle is published to every user. PKCE exists so
    // the installed-app flow does not need one.
    const seen: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      seen.push(new URLSearchParams(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 3600 }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const manager = new TokenManager({ store: memoryStore().store, clientId: "cid", fetchImpl });
    await manager.exchangeCode({ code: "c", verifier: "v", redirectUri: "http://x" });
    expect(seen[0].get("client_secret")).toBeNull();
  });

  it("does not clear an existing session when the exchange itself is rejected", async () => {
    // A rejected verifier is a client bug, not a revoked grant. Wiping the
    // session would sign the user out for something re-authenticating cannot
    // fix.
    const store = memoryStore(tokenSet());
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => JSON.stringify({ error: "invalid_grant" }),
    })) as unknown as typeof fetch;

    const manager = new TokenManager({ store: store.store, clientId: "cid", fetchImpl });
    await expect(
      manager.exchangeCode({ code: "c", verifier: "v", redirectUri: "http://x" }),
    ).rejects.toMatchObject({ kind: "state_mismatch" });
    expect(store.peek()).not.toBeNull();
  });

  it("posts to Google's token endpoint", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "a", expires_in: 3600 }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const manager = new TokenManager({ store: memoryStore().store, clientId: "cid", fetchImpl });
    await manager.exchangeCode({ code: "c", verifier: "v", redirectUri: "http://x" });
    expect(urls[0]).toBe(GOOGLE_TOKEN_URL);
  });
});

describe("the expiry constants", () => {
  it("keeps the stored lifetime above the slack", () => {
    // Otherwise a token can be stored already inside the refresh window.
    expect(MIN_STORED_LIFETIME_MS).toBeGreaterThan(EXPIRY_SLACK_MS);
  });
});

describe("localStorageTokenStore", () => {
  /**
   * The `localStorage` store, tested through the platform layer's name for it.
   *
   * `platform/types.ts` re-exports this rather than keeping its own copy, and the
   * two had already drifted: this one learned that an unparseable blob is *signed
   * out* and removes it, while that one caught the parse and returned `null` with
   * the bad value still in storage. The web build called the latter, so the fix had
   * been going nowhere — which is the whole argument for having one.
   *
   * A hand-rolled stub rather than jsdom, because the suite's environment is
   * deliberately `node`: the guard that keeps `core/` shareable is that its tests
   * cannot reach a DOM shim. The store already treats `localStorage` as optional
   * (`globalThis.localStorage?.`), so a host without one is a supported case and
   * this stub is the shape of that interface rather than a workaround.
   */
  const KEY = "winnow.test.tokens";

  /** Enough of `Storage` for the four methods the store calls, and nothing else. */
  function stubStorage(seed: Record<string, string> = {}) {
    const map = new Map(Object.entries(seed));
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      configurable: true,
      writable: true,
    });
    return { storage, map };
  }

  const tokens: TokenSet = { accessToken: "a", refreshToken: "r", expiresAt: 1 };

  afterEach(() => {
    Reflect.deleteProperty(globalThis as object, "localStorage");
  });

  it("round-trips a token set", async () => {
    stubStorage();
    const store = localStorageTokenStore(KEY);
    await store.write(tokens);
    expect(await store.read()).toEqual(tokens);
  });

  it("is signed out, not broken, when the stored value will not parse", async () => {
    stubStorage({ [KEY]: "{not json" });
    expect(await localStorageTokenStore(KEY).read()).toBeNull();
  });

  it("and removes it, so the next read is a clean signed-out state", async () => {
    // Without the removal this is the bug in miniature: a truncated write leaves
    // the user signed out *and* re-reading the same broken value forever, with
    // nothing on screen to say why.
    const { map } = stubStorage({ [KEY]: "{not json" });
    await localStorageTokenStore(KEY).read();
    expect(map.has(KEY)).toBe(false);
  });

  it("treats a value with no access token as no session, and drops it too", async () => {
    const { map } = stubStorage({ [KEY]: JSON.stringify({ refreshToken: "r" }) });
    expect(await localStorageTokenStore(KEY).read()).toBeNull();
    expect(map.has(KEY)).toBe(false);
  });

  it("clears", async () => {
    stubStorage();
    const store = localStorageTokenStore(KEY);
    await store.write(tokens);
    await store.clear();
    expect(await store.read()).toBeNull();
  });

  it("is signed out, not thrown, on a host with no localStorage at all", async () => {
    // Safari in private mode and a full quota both make the accessor throw or
    // vanish. Losing the cache is not worth failing sign-in over.
    Reflect.deleteProperty(globalThis as object, "localStorage");
    expect(await localStorageTokenStore(KEY).read()).toBeNull();
    await expect(localStorageTokenStore(KEY).write(tokens)).resolves.toBeUndefined();
    await expect(localStorageTokenStore(KEY).clear()).resolves.toBeUndefined();
  });

  it("shares one key with the platform layer, which is what makes it the same store", async () => {
    // Both default to the same key. If either moved, a signed-in web session would
    // silently not be found — the failure one layer up from here.
    stubStorage();
    await webTokenStore().write(tokens);
    expect(await localStorageTokenStore().read()).toEqual(tokens);
    await webTokenStore().clear();
  });
});

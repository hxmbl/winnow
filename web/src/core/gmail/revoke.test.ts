/**
 * Revoking the grant at Google when the user signs out.
 *
 * Sign-out always wiped the tokens on this device; a copy taken earlier (a backup, a
 * synced profile, malware) still worked until Google was told. `clear({ revoke: true })`
 * tells it, and these pin down the two halves of the contract: the revoke is sent
 * exactly once, with the token in the body, and nothing about it can hold up or undo
 * the local sign-out.
 *
 * Token values are built at run time so the repository's secret scan has no literal to
 * flag.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { REVOKE_TIMEOUT_MS, TokenManager, revokeGrant, type TokenStore } from "./tokens";
import { GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL, type TokenSet } from "./dto";

const fake = (kind: string) => ["fake", kind, "for", "tests"].join("-");
const REFRESH = fake("refresh");
const ACCESS = fake("access");

function memoryStore(initial: TokenSet | null) {
  let value = initial;
  const store: TokenStore = {
    read: async () => value,
    write: async (tokens) => void (value = tokens),
    clear: async () => void (value = null),
  };
  return { store, peek: () => value };
}

const session = (over: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: ACCESS,
  refreshToken: REFRESH,
  expiresAt: Date.now() + 3_600_000,
  ...over,
});

type Seen = { url: string; init: RequestInit };

/** A `fetch` that records each request and answers with `answer`. */
function recorder(answer: (url: string) => Promise<Response> | Response) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return answer(String(input));
  }) as unknown as typeof fetch;
  return { fetchImpl, seen, revokes: () => seen.filter((s) => s.url.startsWith(GOOGLE_REVOKE_URL)) };
}

const ok = () => new Response("{}", { status: 200 });

afterEach(() => {
  vi.useRealTimers();
});

describe("revokeGrant", () => {
  it("posts the token as a form body, never in the URL", async () => {
    const { fetchImpl, seen } = recorder(ok);
    expect(await revokeGrant(REFRESH, fetchImpl)).toBe("revoked");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(GOOGLE_REVOKE_URL);
    expect(seen[0].url).not.toContain(REFRESH);
    expect(seen[0].init.method).toBe("POST");
    expect((seen[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(String(seen[0].init.body)).get("token")).toBe(REFRESH);
  });

  it("treats 400 invalid_token as already gone, and swallows other failures", async () => {
    const invalid = recorder(() => new Response(JSON.stringify({ error: "invalid_token" }), { status: 400 }));
    expect(await revokeGrant(REFRESH, invalid.fetchImpl)).toBe("already_invalid");
    const down = recorder(() => new Response("", { status: 503 }));
    expect(await revokeGrant(REFRESH, down.fetchImpl)).toBe("failed");
    const offline = recorder(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await revokeGrant(REFRESH, offline.fetchImpl)).toBe("failed");
  });

  it("gives up after the timeout, even on a fetch that ignores its signal", async () => {
    vi.useFakeTimers();
    const { fetchImpl, seen } = recorder(() => new Promise<Response>(() => {}));
    const outcome = revokeGrant(REFRESH, fetchImpl);
    await vi.advanceTimersByTimeAsync(REVOKE_TIMEOUT_MS);
    expect(await outcome).toBe("failed");
    expect(seen[0].init.signal?.aborted).toBe(true);
    expect(REVOKE_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("TokenManager.clear with revoke", () => {
  it("revokes the refresh token exactly once and wipes the store", async () => {
    const { store, peek } = memoryStore(session());
    const { fetchImpl, revokes } = recorder(ok);
    const manager = new TokenManager({ store, clientId: "id", fetchImpl });
    await manager.hasSession();

    await manager.clear({ revoke: true });
    expect(peek()).toBeNull();
    expect(await manager.revocation).toBe("revoked");
    expect(revokes()).toHaveLength(1);
    expect(new URLSearchParams(String(revokes()[0].init.body)).get("token")).toBe(REFRESH);

    // A second sign-out has nothing left to revoke.
    await manager.clear({ revoke: true });
    expect(revokes()).toHaveLength(1);
  });

  it("captures the token even when the session was never read before sign-out", async () => {
    const { store } = memoryStore(session());
    const { fetchImpl, revokes } = recorder(ok);
    const manager = new TokenManager({ store, clientId: "id", fetchImpl });
    await manager.clear({ revoke: true });
    await manager.revocation;
    expect(revokes()).toHaveLength(1);
  });

  it("falls back to the access token when there is no refresh token", async () => {
    const { store } = memoryStore(session({ refreshToken: undefined }));
    const { fetchImpl, revokes } = recorder(ok);
    const manager = new TokenManager({ store, clientId: "id", fetchImpl });
    await manager.clear({ revoke: true });
    await manager.revocation;
    expect(new URLSearchParams(String(revokes()[0].init.body)).get("token")).toBe(ACCESS);
  });

  it("revokes nothing on a plain clear", async () => {
    const { store, peek } = memoryStore(session());
    const { fetchImpl, seen } = recorder(ok);
    const manager = new TokenManager({ store, clientId: "id", fetchImpl });
    await manager.clear();
    expect(peek()).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it("does not revoke a grant Google already called invalid_grant", async () => {
    const { store, peek } = memoryStore(session({ expiresAt: Date.now() - 1_000 }));
    const { fetchImpl, seen, revokes } = recorder((url) =>
      url === GOOGLE_TOKEN_URL
        ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
        : ok(),
    );
    const manager = new TokenManager({ store, clientId: "id", fetchImpl });
    await expect(manager.validAccessToken()).rejects.toMatchObject({ kind: "reauth_required" });
    expect(peek()).toBeNull();
    // The user then presses Sign out on the stale screen: still nothing to revoke.
    await manager.clear({ revoke: true });
    expect(seen.map((s) => s.url)).toEqual([GOOGLE_TOKEN_URL]);
    expect(revokes()).toHaveLength(0);
  });

  it("signs out at once while the revoke hangs, and the revoke cannot bring the session back", async () => {
    vi.useFakeTimers();
    const { store, peek } = memoryStore(session());
    const { fetchImpl, revokes } = recorder(() => new Promise<Response>(() => {}));
    const manager = new TokenManager({ store, clientId: "id", fetchImpl });

    await manager.clear({ revoke: true });
    expect(peek()).toBeNull();
    expect(await manager.hasSession()).toBe(false);
    expect(revokes()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(REVOKE_TIMEOUT_MS);
    expect(await manager.revocation).toBe("failed");
    expect(peek()).toBeNull();
    expect(await manager.hasSession()).toBe(false);
  });

  it("signs out when the revoke fails outright", async () => {
    const { store, peek } = memoryStore(session());
    const { fetchImpl } = recorder(() => Promise.reject(new TypeError("Failed to fetch")));
    const manager = new TokenManager({ store, clientId: "id", fetchImpl });
    await expect(manager.clear({ revoke: true })).resolves.toBeUndefined();
    expect(await manager.revocation).toBe("failed");
    expect(peek()).toBeNull();
  });
});

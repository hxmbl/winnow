/**
 * The code exchange on a WebView that was paused behind the browser (Android).
 *
 * The defect: the redirect reached the loopback listener while Winnow's WebView was
 * in the background, the token request went out from the paused WebView, and `fetch`
 * rejected with `TypeError: Failed to fetch` — shown to the user verbatim. These pin
 * the fix: wait for the foreground before each attempt, resend only a request that
 * never got an HTTP response, never resend one Google answered (`invalid_grant`
 * above all: the code is single-use), and say something plain when Google stays
 * unreachable.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDebugLog, debugLogText, setDebugLogEnabled } from "../debug/debugLog";
import {
  EXCHANGE_RETRY_DELAYS_MS,
  EXCHANGE_UNREACHABLE_MESSAGE,
  SignInUnreachable,
  exchangeWithRetry,
  isFetchRejection,
  isUnreachable,
  retryWhileUnreachable,
} from "./exchangeRetry";
import { describeFailure } from "./errors";
import { TokenManager, type TokenStore } from "../gmail/tokens";
import { GmailError, GoogleUnreachable, type TokenSet } from "../gmail/dto";

function memoryStore(): TokenStore {
  let value: TokenSet | null = null;
  return {
    read: async () => value,
    write: async (tokens) => void (value = tokens),
    clear: async () => void (value = null),
  };
}

const ok = () =>
  new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const rejected = (error: string, status = 400) =>
  new Response(JSON.stringify({ error, error_description: "Bad Request" }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** A real `TokenManager` whose `fetch` plays the given answers in order. */
function managerAnswering(...answers: Array<() => Response | Promise<Response>>) {
  const fetchImpl = vi.fn(async () => {
    const next = answers.shift();
    if (!next) throw new Error("unexpected extra token request");
    return next();
  });
  const manager = new TokenManager({
    store: memoryStore(),
    clientId: "id",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const exchange = () =>
    manager.exchangeCode({ code: "c", verifier: "v", redirectUri: "http://127.0.0.1:4242/winnow-oauth" });
  return { fetchImpl, exchange };
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const noSleep = vi.fn(async () => {});

describe("exchangeWithRetry", () => {
  it("exchanges once when the first attempt works", async () => {
    const { fetchImpl, exchange } = managerAnswering(ok);
    const tokens = await exchangeWithRetry(exchange, { sleep: noSleep });
    expect(tokens.accessToken).toBe("a");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resends a request that never got a response, with backoff", async () => {
    const sleep = vi.fn(async (ms: number) => void ms);
    const { fetchImpl, exchange } = managerAnswering(offline, offline, ok);
    const tokens = await exchangeWithRetry(exchange, { sleep });
    expect(tokens.accessToken).toBe("a");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(EXCHANGE_RETRY_DELAYS_MS.slice(0, 2));
  });

  it("never resends after Google answers invalid_grant", async () => {
    const { fetchImpl, exchange } = managerAnswering(() => rejected("invalid_grant"), ok);
    const reason = await exchangeWithRetry(exchange, { sleep: noSleep }).catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reason).toBeInstanceOf(GmailError);
    expect(reason).not.toBeInstanceOf(GoogleUnreachable);
    expect((reason as Error).message).toContain("invalid_grant");
  });

  it("stops at invalid_grant even when it follows an unreachable attempt", async () => {
    // The first request may have reached Google and spent the code before its
    // answer was lost; the resend then reads invalid_grant, and that is final.
    const { fetchImpl, exchange } = managerAnswering(offline, () => rejected("invalid_grant"), ok);
    const reason = await exchangeWithRetry(exchange, { sleep: noSleep }).catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((reason as Error).message).toContain("invalid_grant");
  });

  it.each([
    ["invalid_client", 401],
    ["redirect_uri_mismatch", 400],
    ["backend_error", 503],
  ])("never resends any other answer from Google (%s)", async (error, status) => {
    const { fetchImpl, exchange } = managerAnswering(() => rejected(error, status), ok);
    await expect(exchangeWithRetry(exchange, { sleep: noSleep })).rejects.toBeInstanceOf(GmailError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up with a plain sentence, not 'Failed to fetch'", async () => {
    const attempts = EXCHANGE_RETRY_DELAYS_MS.length + 1;
    const { fetchImpl, exchange } = managerAnswering(...Array.from({ length: attempts }, () => offline));
    const reason = await exchangeWithRetry(exchange, { sleep: noSleep }).catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(attempts);
    expect(reason).toBeInstanceOf(SignInUnreachable);
    expect(reason).toMatchObject({ kind: "network", message: EXCHANGE_UNREACHABLE_MESSAGE });
    expect((reason as Error).message).not.toContain("Failed to fetch");
  });

  it("is shown to the user as the plain sentence", () => {
    // The sign-in screen shows message and hint; the setup sheet joins them.
    const failure = describeFailure(new SignInUnreachable());
    expect(`${failure.message} ${failure.hint}`).toBe(EXCHANGE_UNREACHABLE_MESSAGE);
    expect(failure.retryable).toBe(true);
  });

  it("waits for the foreground before every attempt, the first included", async () => {
    const order: string[] = [];
    const waitForForeground = vi.fn(async () => void order.push("wait"));
    const { exchange } = managerAnswering(offline, ok);
    await exchangeWithRetry(
      async () => {
        order.push("exchange");
        return exchange();
      },
      { waitForForeground, sleep: noSleep },
    );
    expect(order).toEqual(["wait", "exchange", "wait", "exchange"]);
  });

  it("does not start the exchange until the wait resolves", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetchImpl, exchange } = managerAnswering(ok);
    const done = exchangeWithRetry(exchange, { waitForForeground: () => gate, sleep: noSleep });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fetchImpl).not.toHaveBeenCalled();
    release();
    await done;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("still exchanges when the foreground wait itself fails", async () => {
    const { fetchImpl, exchange } = managerAnswering(ok);
    await exchangeWithRetry(exchange, {
      waitForForeground: () => Promise.reject(new Error("no window")),
      sleep: noSleep,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not treat other errors as unreachable", () => {
    expect(isUnreachable(new GoogleUnreachable("Could not reach Google: Failed to fetch"))).toBe(true);
    expect(isUnreachable(new GmailError("x", 0, "network"))).toBe(false);
    expect(isUnreachable(new TypeError("Failed to fetch"))).toBe(false);
    expect(isUnreachable(new GmailError("invalid_grant", 400, "state_mismatch"))).toBe(false);
  });
});

describe("retryWhileUnreachable (the profile read after sign-in)", () => {
  it("resends a bare fetch rejection from the Gmail client", async () => {
    const profile = vi
      .fn<() => Promise<{ emailAddress: string }>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ emailAddress: "a@example.com" });
    const result = await retryWhileUnreachable(profile, { retryable: isFetchRejection, sleep: noSleep });
    expect(result.emailAddress).toBe("a@example.com");
    expect(profile).toHaveBeenCalledTimes(2);
  });

  it("does not resend an HTTP error from Gmail", async () => {
    const profile = vi.fn(async () => {
      throw new GmailError("Gmail returned 403", 403);
    });
    await expect(
      retryWhileUnreachable(profile, { retryable: isFetchRejection, sleep: noSleep }),
    ).rejects.toMatchObject({ status: 403 });
    expect(profile).toHaveBeenCalledTimes(1);
  });

  it("classifies only fetch rejections as resendable", () => {
    expect(isFetchRejection(new TypeError("Failed to fetch"))).toBe(true);
    expect(isFetchRejection(new GoogleUnreachable("Could not reach Google: Failed to fetch"))).toBe(true);
    expect(isFetchRejection(new SyntaxError("Unexpected end of JSON input"))).toBe(false);
    expect(isFetchRejection(new GmailError("invalid_grant", 400, "state_mismatch"))).toBe(false);
  });
});

describe("the debug log", () => {
  afterEach(() => {
    setDebugLogEnabled(false);
    clearDebugLog();
  });

  it("records each attempt, the foreground wait and the retry, never the code", async () => {
    setDebugLogEnabled(true);
    let calls = 0;
    const result = await exchangeWithRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new GoogleUnreachable("Could not reach Google: Failed to fetch");
        return "tokens";
      },
      { waitForForeground: async () => true, sleep: async () => undefined, label: "code-exchange" },
    );
    expect(result).toBe("tokens");
    const log = debugLogText();
    expect(log).toMatch(/auth foreground-wait for=code-exchange attempt=0 visible=true/);
    expect(log).toMatch(/auth attempt-failed for=code-exchange attempt=0 kind=network status=0 retry=true delayMs=500/);
    expect(log).toMatch(/auth attempt-ok for=code-exchange attempt=1/);
  });
});

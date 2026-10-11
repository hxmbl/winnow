/**
 * The web platform's sign-in navigation.
 *
 * The behavioral contract of `beginSignIn` on the web is the fix these tests
 * pin: the promise **must not settle** after asking the browser to navigate.
 * The session layer `await`s it; if it resolves with `{ kind: "cancelled" }`,
 * the session reads a cancellation, discards the pending PKCE verifier (a
 * microtask — it runs before the navigation), and the redirect back from Google
 * finds nothing to exchange with. That was the reported failure: every web
 * sign-in ended in "Sign-in could not be verified."
 *
 * Only a navigation the browser *refused* settles, with a fault — hanging
 * forever on a page load that cannot happen is worse than saying so.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webPlatform } from "./web";
import { webTokenStore } from "./types";
import type { SignInRequest, SignInResult } from "./types";

const AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?state=s0&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback";

const REQUEST: SignInRequest = { authorizeUrl: AUTHORIZE_URL, timeoutMs: 300_000 };

/** A `location` whose `assign` records what it was asked to open. */
function installLocation(assign: (url: string | URL) => void): void {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { assign, search: "", origin: "http://localhost:5173" },
  });
}

function installSessionStorage(): void {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    },
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, "location");
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "location");
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

describe("webPlatform.beginSignIn", () => {
  it("records the state and asks the browser to navigate, without ever settling", async () => {
    installSessionStorage();
    const assigned: string[] = [];
    installLocation((url) => void assigned.push(String(url)));

    const inflight = webPlatform.beginSignIn(REQUEST);
    let settled: string | null = null;
    void inflight.then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );
    await flush();

    expect(assigned).toEqual([AUTHORIZE_URL]);
    // So the sign-in screen can show "signing in…" across the reload.
    expect(globalThis.sessionStorage?.getItem("winnow.pendingState")).toBe("s0");
    expect(settled).toBeNull();
  });

  it("settles with a fault when the browser refuses the navigation", async () => {
    installSessionStorage();
    const refused = new Error("blocked by the browser");
    installLocation(() => {
      throw refused;
    });

    const result: SignInResult = await webPlatform.beginSignIn(REQUEST);
    expect(result).toEqual({ kind: "unavailable", detail: "blocked by the browser" });
  });

  it("settles with a fault when there is no browser to navigate", async () => {
    // For example a headless embed. A never-resolving promise here would hang
    // the calling session forever, so it must say so and settle.
    const result: SignInResult = await webPlatform.beginSignIn(REQUEST);
    expect(result).toEqual({
      kind: "unavailable",
      detail: "there is no browser to navigate to Google",
    });
  });
});

describe("webTokenStore", () => {
  it("is importable alongside the platform (the boundary stays one shape)", () => {
    expect(typeof webTokenStore).toBe("function");
  });
});
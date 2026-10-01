/**
 * The pending-sign-in stash.
 *
 * The interesting property is not that it round-trips a string — it is what it
 * does *when things go wrong*, because a stash of live PKCE verifiers is exactly
 * the kind of state where "be permissive" is a security decision rather than a
 * style choice.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingAuth,
  forgetPendingAuth,
  rememberPendingAuth,
  takePendingAuth,
} from "./pendingAuth";

const ENTRY = {
  state: "state-1",
  verifier: "verifier-1",
  redirectUri: "https://app.example/auth/callback",
};

/** A minimal in-memory `sessionStorage`, since the module uses the global. */
function installStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    },
  });
  return backing;
}

describe("the pending sign-in stash", () => {
  let backing: Map<string, string>;

  beforeEach(() => {
    backing = installStorage();
  });

  it("hands back what was remembered, keyed by state", () => {
    rememberPendingAuth(ENTRY);
    expect(takePendingAuth("state-1")?.verifier).toBe("verifier-1");
  });

  it("returns null for a state it never issued", () => {
    rememberPendingAuth(ENTRY);
    // The property the web sign-in flow rests on: an attacker-supplied code with
    // someone else's state finds no verifier, so the exchange never happens.
    expect(takePendingAuth("somebody-elses-state")).toBeNull();
  });

  it("removes the entry on read, because a code is single-use", () => {
    rememberPendingAuth(ENTRY);
    takePendingAuth("state-1");
    // A replayed redirect must not find a verifier still waiting for it.
    expect(takePendingAuth("state-1")).toBeNull();
  });

  it("keeps concurrent sign-ins apart", () => {
    // Signing in on two tabs is unusual but not something to break: a single-slot
    // stash would make the second tab's exchange fail with "invalid_grant".
    rememberPendingAuth(ENTRY);
    rememberPendingAuth({ ...ENTRY, state: "state-2", verifier: "verifier-2" });

    expect(takePendingAuth("state-2")?.verifier).toBe("verifier-2");
    expect(takePendingAuth("state-1")?.verifier).toBe("verifier-1");
  });

  it("forgets a declined sign-in", () => {
    rememberPendingAuth(ENTRY);
    forgetPendingAuth("state-1");
    expect(takePendingAuth("state-1")).toBeNull();
  });

  it("clears everything on sign-out", () => {
    rememberPendingAuth(ENTRY);
    rememberPendingAuth({ ...ENTRY, state: "state-2" });
    clearPendingAuth();
    expect(takePendingAuth("state-1")).toBeNull();
    expect(takePendingAuth("state-2")).toBeNull();
  });

  it("drops an entry older than the sign-in window", () => {
    rememberPendingAuth(ENTRY);
    // Aged past the 15-minute cap by rewriting the stored timestamp.
    const key = "winnow.pendingAuth";
    const entries = JSON.parse(backing.get(key) ?? "[]") as { at: number }[];
    entries.forEach((entry) => {
      entry.at -= 16 * 60 * 1000;
    });
    backing.set(key, JSON.stringify(entries));

    // A tab left open on the sign-in screen overnight must not still be able to
    // complete an exchange hours later.
    expect(takePendingAuth("state-1")).toBeNull();
  });

  it("survives storage that holds something unexpected", () => {
    // A corrupt value is not worth throwing over: the sign-in simply has to be
    // restarted, which is a much better failure than a blank page.
    backing.set("winnow.pendingAuth", "{not json");
    expect(takePendingAuth("state-1")).toBeNull();

    backing.set("winnow.pendingAuth", JSON.stringify({ not: "an array" }));
    expect(takePendingAuth("state-1")).toBeNull();

    backing.set("winnow.pendingAuth", JSON.stringify([{ state: 42 }]));
    expect(takePendingAuth("state-1")).toBeNull();
  });

  it("survives sessionStorage being unavailable entirely", () => {
    // Private-mode Safari, and any build with storage blocked. Remembering throws
    // nothing, and taking finds nothing — so the desktop-style sign-in still works
    // and only the web redirect is unavailable.
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage is disabled");
      },
    });

    expect(() => rememberPendingAuth(ENTRY)).not.toThrow();
    expect(takePendingAuth("state-1")).toBeNull();
  });
});
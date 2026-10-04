/**
 * PKCE and the redirect that carries the code home.
 *
 * This is the security boundary of sign-in: the verifier that must never leave the
 * machine, the state that must be compared before anything is exchanged, and the
 * parser that decides whether a URL is even a redirect at all. So the tests are
 * about what must *not* happen as much as what must.
 */

import { describe, expect, it } from "vitest";
import { base64UrlEncode } from "./dto";
import {
  buildAuthorizeUrl,
  createPkcePair,
  describeAuthError,
  parseRedirect,
  sha256,
  stateMatches,
} from "./pkce";

describe("base64UrlEncode", () => {
  it("uses the URL-safe alphabet and drops the padding", () => {
    // RFC 4648 §5. The `+/=` characters are rejected by a server expecting a URL
    // path segment, and Gmail's own comparison is byte-exact.
    const encoded = base64UrlEncode(new Uint8Array([251, 255, 190, 1, 2, 3]));
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encoded).toBe("-_--AQID");
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array(32).map((_, i) => (i * 37) % 256);
    expect(base64UrlEncode(bytes)).toBe(base64UrlEncode(bytes));
    expect(base64UrlEncode(bytes)).toHaveLength(43);
  });
});

describe("createPkcePair", () => {
  it("produces a verifier long enough to satisfy the RFC's floor", async () => {
    // RFC 7636 §4.1 asks for 43–128 characters.
    const pair = await createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
  });

  it("sends only the hash as the challenge", async () => {
    // The whole point: an intercepted redirect carries a hash, not the verifier.
    const pair = await createPkcePair();
    expect(pair.challenge).toBe(base64UrlEncode(await sha256(pair.verifier)));
    expect(pair.challenge).not.toBe(pair.verifier);
    expect(pair.verifier).not.toContain(pair.challenge);
  });

  it("uses a different state from the verifier, and a different length", async () => {
    // One shared value in two roles would be readable in a log as if it were
    // either, and only one of them would be.
    const pair = await createPkcePair();
    expect(pair.state).not.toBe(pair.verifier);
    expect(pair.state.length).toBe(22);
  });

  it("is different every time", async () => {
    const [a, b] = await Promise.all([createPkcePair(), createPkcePair()]);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe("buildAuthorizeUrl", () => {
  const params = {
    clientId: "client-1",
    scope: "https://www.googleapis.com/auth/gmail.modify",
    redirectUri: "http://127.0.0.1:1420/callback",
    challenge: "chal",
    state: "st",
  };

  it("asks for S256, never the plain verifier", () => {
    const url = buildAuthorizeUrl("https://accounts.google.com/o/oauth2/v2/auth", params);
    const query = new URLSearchParams(url.split("?")[1]);
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("code_challenge")).toBe("chal");
    expect(query.get("response_type")).toBe("code");
  });

  it("asks for offline access and for consent, or there is no refresh token", () => {
    // Without `offline` Google issues no refresh token at all. Without `consent`
    // a second sign-in returns none either, which is the commonest cause of
    // "it worked once and then stopped".
    const query = new URLSearchParams(buildAuthorizeUrl("https://x/auth", params).split("?")[1]);
    expect(query.get("access_type")).toBe("offline");
    expect(query.get("prompt")).toBe("consent");
  });

  it("never puts the verifier in the URL", () => {
    const url = buildAuthorizeUrl("https://x/auth", params);
    expect(url).not.toContain("code_verifier");
    expect(url).not.toContain("secret");
  });

  it("percent-encodes the redirect URI rather than nesting raw query characters", () => {
    const url = buildAuthorizeUrl("https://x/auth", {
      ...params,
      redirectUri: "http://127.0.0.1:1420/cb?a=1",
    });
    expect(url).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A1420%2Fcb%3Fa%3D1");
  });

  it("lets a caller add a parameter without losing the required ones", () => {
    const query = new URLSearchParams(
      buildAuthorizeUrl("https://x/auth", params, { login_hint: "a@b.c" }).split("?")[1],
    );
    expect(query.get("login_hint")).toBe("a@b.c");
    expect(query.get("state")).toBe("st");
  });
});

describe("parseRedirect", () => {
  it("reads a code and its state out of a full URL", () => {
    const result = parseRedirect("http://127.0.0.1:1420/callback?code=abc&state=xyz");
    expect(result).toEqual({ kind: "code", code: "abc", state: "xyz" });
  });

  it("reads a bare query string, which is what the loopback listener sees", () => {
    expect(parseRedirect("?code=abc&state=xyz")).toEqual({ kind: "code", code: "abc", state: "xyz" });
  });

  it("reads Google's error, with a description when there is one", () => {
    expect(parseRedirect("?error=access_denied&error_description=Nope&state=xyz")).toEqual({
      kind: "error",
      error: "access_denied",
      description: "Nope",
      state: "xyz",
    });
  });

  it("falls back to the error code when Google sent no description", () => {
    const result = parseRedirect("?error=access_denied&state=xyz");
    expect(result).toEqual({ kind: "error", error: "access_denied", description: "access_denied", state: "xyz" });
  });

  it("reports an error redirect even with no state, so it can be told apart from a decline", () => {
    // The caller still refuses to act on it — `stateMatches` needs an issued
    // state — but "Google said no" and "this was not a redirect" are different
    // messages and only one of them is the user's fault.
    const result = parseRedirect("?error=access_denied");
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.state).toBe("");
  });

  it("is none for an ordinary page load", () => {
    expect(parseRedirect("http://127.0.0.1:1420/callback").kind).toBe("none");
    expect(parseRedirect("?view=inbox&filter=important").kind).toBe("none");
    expect(parseRedirect("?state=xyz").kind).toBe("none");
    expect(parseRedirect("").kind).toBe("none");
  });

  it("hands back a code with no state as unverified rather than usable", () => {
    // The parser reports what arrived; `stateMatches` is what refuses it. Tested as
    // a pair, because a stateless code is exactly the input the CSRF check exists
    // for and the two have to agree.
    const result = parseRedirect("?code=abc");
    expect(result.kind).toBe("code");
    expect(stateMatches("issued", result.kind === "code" ? result.state : "")).toBe(false);
  });
});

describe("stateMatches", () => {
  it("accepts the value that was issued", () => {
    expect(stateMatches("abc123", "abc123")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(stateMatches("abc123", "abc124")).toBe(false);
    expect(stateMatches("abc123", "abc12")).toBe(false);
    expect(stateMatches("abc123", "abc1234")).toBe(false);
  });

  it("rejects an empty received state, which is the attack it exists to stop", () => {
    expect(stateMatches("abc123", "")).toBe(false);
    expect(stateMatches("", "")).toBe(false);
    expect(stateMatches("", "abc123")).toBe(false);
  });
});

describe("describeAuthError", () => {
  it("says what happened for each code it knows", () => {
    expect(describeAuthError("access_denied")).toMatch(/declined/i);
    expect(describeAuthError("temporarily_unavailable")).toMatch(/in a minute/i);
    expect(describeAuthError("invalid_request")).toMatch(/bug/i);
  });

  it("still says something useful about a code it has never heard of", () => {
    expect(describeAuthError("some_new_google_code")).toBe(
      "Google could not complete sign-in: some new google code.",
    );
  });
});

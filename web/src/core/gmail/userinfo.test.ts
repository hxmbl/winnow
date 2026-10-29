import { describe, expect, it, vi } from "vitest";
import { GMAIL_SCOPE, PROFILE_SCOPE, SIGN_IN_SCOPE, SIGN_IN_SCOPES, keepsGmail, profileGrant, withProfileScope } from "./dto";
import { USERINFO_URL, fetchOwnProfile, isProfileScopeMissing, ownPictureUrl, parseUserinfo } from "./userinfo";
import type { FetchLike } from "./client";

const PICTURE = "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c";

describe("the sign-in scopes", () => {
  it("are Gmail and the basic profile, as full URLs the native sign-in accepts", () => {
    expect(SIGN_IN_SCOPES).toEqual([GMAIL_SCOPE, PROFILE_SCOPE]);
    expect(PROFILE_SCOPE).toBe("https://www.googleapis.com/auth/userinfo.profile");
    expect(SIGN_IN_SCOPE).toBe(`${GMAIL_SCOPE} ${PROFILE_SCOPE}`);
    // The Rust and Kotlin native sign-in only pass Google API scope URLs.
    for (const scope of SIGN_IN_SCOPES) expect(scope.startsWith("https://www.googleapis.com/auth/")).toBe(true);
  });

  it("tell a grant with the profile from one signed in before it was asked for", () => {
    expect(profileGrant(SIGN_IN_SCOPE)).toBe("granted");
    expect(profileGrant(`${GMAIL_SCOPE} profile`)).toBe("granted");
    expect(profileGrant(`openid ${PROFILE_SCOPE}  ${GMAIL_SCOPE}`)).toBe("granted");
    expect(profileGrant(GMAIL_SCOPE)).toBe("not_granted");
    expect(profileGrant(`${GMAIL_SCOPE} https://www.googleapis.com/auth/contacts.readonly`)).toBe("not_granted");
    expect(profileGrant(undefined)).toBe("unknown");
    expect(profileGrant(null)).toBe("unknown");
    expect(profileGrant("  ")).toBe("unknown");
  });
});

describe("upgrading a session from before the basic profile", () => {
  const DRIVE = "https://www.googleapis.com/auth/drive.file";
  it("adds the profile to any trip to Google whose grant lacks it", () => {
    expect(withProfileScope(DRIVE, GMAIL_SCOPE)).toBe(`${DRIVE} ${PROFILE_SCOPE}`);
    expect(withProfileScope(DRIVE, undefined)).toBe(`${DRIVE} ${PROFILE_SCOPE}`);
  });

  it("leaves a trip alone when the grant has it, or the trip already asks for it", () => {
    expect(withProfileScope(DRIVE, SIGN_IN_SCOPE)).toBe(DRIVE);
    expect(withProfileScope(PROFILE_SCOPE, GMAIL_SCOPE)).toBe(PROFILE_SCOPE);
    expect(withProfileScope(SIGN_IN_SCOPE, GMAIL_SCOPE)).toBe(SIGN_IN_SCOPE);
  });

  it("knows when a new grant would have dropped Gmail", () => {
    expect(keepsGmail(SIGN_IN_SCOPE)).toBe(true);
    expect(keepsGmail(undefined)).toBe(true);
    expect(keepsGmail(PROFILE_SCOPE)).toBe(false);
  });
});

describe("the own profile picture URL", () => {
  it("keeps Google's image host only, sized for an avatar", () => {
    expect(ownPictureUrl("https://lh3.googleusercontent.com/a/ACg8ocK=s100")).toBe(PICTURE);
    expect(ownPictureUrl("https://lh3.googleusercontent.com/a/ACg8ocK")).toBe(PICTURE);
    expect(ownPictureUrl("https://yt3.ggpht.com/abc=s100")).toBe("https://yt3.ggpht.com/abc=s100");
  });

  it("drops anything else", () => {
    expect(ownPictureUrl("http://lh3.googleusercontent.com/a/x")).toBeNull();
    expect(ownPictureUrl("https://evil.example/a.png")).toBeNull();
    expect(ownPictureUrl("https://googleusercontent.com.evil.example/a")).toBeNull();
    expect(ownPictureUrl("javascript:alert(1)")).toBeNull();
    expect(ownPictureUrl("")).toBeNull();
    expect(ownPictureUrl(42)).toBeNull();
  });

  it("reads only the name and picture of a userinfo answer", () => {
    expect(parseUserinfo({ sub: "1", name: " Ada L ", picture: "https://lh3.googleusercontent.com/a/ACg8ocK=s100" })).toEqual({
      name: "Ada L",
      picture: PICTURE,
    });
    expect(parseUserinfo({ sub: "1" })).toEqual({ name: null, picture: null });
    expect(parseUserinfo(null)).toEqual({ name: null, picture: null });
  });
});

describe("isProfileScopeMissing", () => {
  it("is a 401/403 that names the scope, nothing else", () => {
    expect(isProfileScopeMissing(403, "", 'Bearer error="insufficient_scope"')).toBe(true);
    expect(isProfileScopeMissing(401, "", 'Bearer realm="x", error="insufficient_scope"')).toBe(true);
    expect(isProfileScopeMissing(403, '{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}', null)).toBe(true);
    expect(isProfileScopeMissing(401, '{"error":"invalid_token"}', 'Bearer error="invalid_token"')).toBe(false);
    expect(isProfileScopeMissing(500, "insufficient_scope", null)).toBe(false);
  });
});

type Answer = { status: number; body?: string; authenticate?: string };

function fetchWith(answers: Answer[]) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const answer = answers.shift() ?? { status: 500 };
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      text: async () => answer.body ?? "",
      headers: { get: (name: string) => (name.toLowerCase() === "www-authenticate" ? (answer.authenticate ?? null) : null) },
    };
  };
  return { fetchImpl, calls };
}

describe("fetchOwnProfile", () => {
  it("reads the picture from userinfo with the access token", async () => {
    const { fetchImpl, calls } = fetchWith([{ status: 200, body: JSON.stringify({ name: "Ada", picture: "https://lh3.googleusercontent.com/a/ACg8ocK=s100" }) }]);
    await expect(fetchOwnProfile(async () => "tok", { fetchImpl })).resolves.toEqual({ kind: "ok", name: "Ada", picture: PICTURE });
    expect(calls).toEqual([{ url: USERINFO_URL, auth: "Bearer tok" }]);
  });

  it("says not_granted for a token without the profile scope, without refreshing", async () => {
    const onUnauthorized = vi.fn(async () => "fresh");
    const { fetchImpl, calls } = fetchWith([{ status: 403, authenticate: 'Bearer error="insufficient_scope"' }]);
    await expect(fetchOwnProfile(async () => "tok", { fetchImpl, onUnauthorized })).resolves.toEqual({ kind: "not_granted" });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("refreshes once on a plain 401, then reads", async () => {
    const onUnauthorized = vi.fn(async () => "fresh");
    const { fetchImpl, calls } = fetchWith([{ status: 401 }, { status: 200, body: "{}" }]);
    await expect(fetchOwnProfile(async () => "old", { fetchImpl, onUnauthorized })).resolves.toEqual({
      kind: "ok",
      name: null,
      picture: null,
    });
    expect(calls.map((call) => call.auth)).toEqual(["Bearer old", "Bearer fresh"]);
  });

  it("reads a refreshed token that is still refused as not_granted, never an error", async () => {
    const { fetchImpl } = fetchWith([{ status: 401 }, { status: 401 }]);
    await expect(fetchOwnProfile(async () => "old", { fetchImpl, onUnauthorized: async () => "fresh" })).resolves.toEqual({
      kind: "not_granted",
    });
  });

  it("throws for what is not about the grant", async () => {
    await expect(fetchOwnProfile(async () => null, { fetchImpl: fetchWith([]).fetchImpl })).rejects.toMatchObject({ kind: "reauth_required" });
    await expect(fetchOwnProfile(async () => "tok", { fetchImpl: fetchWith([{ status: 503 }]).fetchImpl })).rejects.toThrow(/503/);
    await expect(
      fetchOwnProfile(async () => "tok", { fetchImpl: fetchWith([{ status: 401 }]).fetchImpl, onUnauthorized: async () => null }),
    ).rejects.toMatchObject({ kind: "reauth_required" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { parseNativeSignInResult, parseSigningInfo } from "./nativeGoogle";
import { openSignInPage } from "./desktop";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ exit: vi.fn(), onBackButtonPress: vi.fn() }));

type Call = (command: string, args: Record<string, unknown>) => Promise<unknown>;

const SHA1 = "A9:99:3E:36:47:06:81:6A:BA:3E:25:71:78:50:C2:6C:9C:D0:D8:9D";

describe("parseNativeSignInResult", () => {
  it("reads a code and its granted scopes", () => {
    expect(parseNativeSignInResult({ kind: "code", code: " 4/abc ", grantedScopes: ["s1", 3, ""] })).toEqual({
      kind: "code",
      code: "4/abc",
      grantedScopes: ["s1"],
    });
  });

  it("reads a cancel", () => {
    expect(parseNativeSignInResult({ kind: "cancelled" })).toEqual({ kind: "cancelled" });
  });

  it("keeps a known reason and caps the detail", () => {
    const result = parseNativeSignInResult({ kind: "unavailable", reason: "developer_error", detail: "x".repeat(500) });
    expect(result).toMatchObject({ kind: "unavailable", reason: "developer_error" });
    expect(result.kind === "unavailable" && result.detail.length).toBe(200);
  });

  it("turns anything else into a fallback, never a code", () => {
    for (const raw of [null, undefined, "code", 42, {}, { kind: "code" }, { kind: "code", code: "  " }, { kind: "weird" }]) {
      expect(parseNativeSignInResult(raw).kind).toBe("unavailable");
    }
    expect(parseNativeSignInResult({ kind: "unavailable", reason: "made_up" })).toMatchObject({ reason: "failed" });
  });
});

describe("parseSigningInfo", () => {
  it("reads the package, fingerprint and Play services flag", () => {
    expect(parseSigningInfo({ packageName: "app.winnow.android", sha1: SHA1, playServices: true })).toEqual({
      packageName: "app.winnow.android",
      sha1: SHA1,
      playServices: true,
    });
  });

  it("drops a fingerprint that is not one, and refuses no package", () => {
    expect(parseSigningInfo({ packageName: "app.winnow.android", sha1: "abc" })).toEqual({
      packageName: "app.winnow.android",
      sha1: null,
      playServices: false,
    });
    expect(parseSigningInfo({ sha1: SHA1 })).toBeNull();
    expect(parseSigningInfo(null)).toBeNull();
  });
});

describe("openSignInPage", () => {
  it("uses a Custom Tab on Android", async () => {
    const call = vi.fn<Call>(async () => undefined);
    await openSignInPage("https://accounts.google.com/o/oauth2/v2/auth", true, call);
    expect(call.mock.calls).toEqual([["open_sign_in_tab", { url: "https://accounts.google.com/o/oauth2/v2/auth" }]]);
  });

  it("falls back to the system browser when the tab cannot open", async () => {
    const call = vi.fn<Call>(async (command) => {
      if (command === "open_sign_in_tab") throw new Error("no tab");
    });
    await openSignInPage("https://accounts.google.com/x", true, call);
    expect(call.mock.calls.map(([command]) => command)).toEqual(["open_sign_in_tab", "open_external"]);
  });

  it("uses the system browser everywhere else", async () => {
    const call = vi.fn<Call>(async () => undefined);
    await openSignInPage("https://accounts.google.com/x", false, call);
    expect(call.mock.calls.map(([command]) => command)).toEqual(["open_external"]);
  });

  it("reports whether Android kept the app running behind the tab", async () => {
    const kept = vi.fn<Call>(async () => ({ keptAlive: true, keepAlive: "running" }));
    expect(await openSignInPage("https://accounts.google.com/x", true, kept)).toEqual({ via: "custom-tab", keptAlive: true, keepAlive: "running" });
    // An older shell answers nothing: the tab still opened, unprotected.
    const old = vi.fn<Call>(async () => undefined);
    expect(await openSignInPage("https://accounts.google.com/x", true, old)).toEqual({ via: "custom-tab", keptAlive: false, keepAlive: "unknown" });
    const browser = vi.fn<Call>(async (command) => {
      if (command === "open_sign_in_tab") throw new Error("no tab");
    });
    expect(await openSignInPage("https://accounts.google.com/x", true, browser)).toEqual({ via: "browser", keptAlive: false, keepAlive: "none" });
  });
});

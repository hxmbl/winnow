import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEBUG_LOG_CAP,
  NOTIFY_DELAY_MS,
  clearDebugLog,
  debugLog,
  debugLogLines,
  debugLogSize,
  debugLogText,
  mergeNativeDebugLines,
  redactValue,
  setDebugLogEnabled,
  setNativeDebugBridge,
  subscribeDebugLog,
  syncNativeDebugLog,
  visibleDebugText,
} from "./debugLog";

afterEach(() => {
  setNativeDebugBridge(null);
  setDebugLogEnabled(false);
  clearDebugLog();
  vi.useRealTimers();
});

describe("Debug log", () => {
  it("records nothing while it is off", () => {
    debugLog("sync", "start", { initial: false });
    expect(debugLogLines()).toEqual([]);
  });

  it("records area, event, ids, counts and timings while it is on", () => {
    setDebugLogEnabled(true);
    clearDebugLog(); // the "debug-log-on" line
    debugLog("sync", "done", { ms: 412, fetched: 37, failed: 0, history: "1234567" }, Date.UTC(2026, 9, 23, 19, 0, 0));
    expect(debugLogLines()).toEqual(["2026-10-23T19:00:00.000Z sync done ms=412 fetched=37 failed=0 history=1234567"]);
  });

  it("stops again when turned off, keeping what is there", () => {
    setDebugLogEnabled(true);
    clearDebugLog();
    debugLog("updates", "check", { manual: true });
    setDebugLogEnabled(false);
    debugLog("updates", "check", { manual: false });
    expect(debugLogLines()).toHaveLength(1);
  });

  it("keeps at most the cap, dropping the oldest", () => {
    setDebugLogEnabled(true);
    for (let i = 0; i < DEBUG_LOG_CAP + 25; i++) debugLog("notify", "posted", { n: i });
    const kept = debugLogLines();
    expect(DEBUG_LOG_CAP).toBe(10_000);
    expect(kept).toHaveLength(DEBUG_LOG_CAP);
    expect(kept[0]).toMatch(/ n=25$/);
    expect(kept.at(-1)).toMatch(/ n=10024$/);
  });

  it("redacts email addresses, tokens and message content", () => {
    expect(redactValue("account", "sam.lee+x@example.co.uk")).toBe("[email]");
    expect(redactValue("error", "401 for ya29.a0AfH6SMBx-long_token")).toBe('"401 for [token]"');
    expect(redactValue("auth", "Bearer abc.def")).toBe("[token]");
    expect(redactValue("key", "AIzaSyD-very-long-api-key-1234567890abcdef")).toBe("[token]");
    expect(redactValue("jwt", "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl")).toBe("[token]");
    expect(redactValue("subject", "Your payslip")).toBe("[subject: 12 chars]");
    expect(redactValue("body", "secret words")).toBe("[body: 12 chars]");
    expect(redactValue("reason", "some words ".repeat(20))).toBe("[text: 220 chars]");
    // Ids, counts and kinds survive.
    expect(redactValue("gmailId", "18c2f4a9b1d3e5f7")).toBe("18c2f4a9b1d3e5f7");
    expect(redactValue("kind", "offer")).toBe("offer");
    expect(redactValue("count", 3)).toBe("3");
  });

  it("redacts inside a whole line, the event included", () => {
    setDebugLogEnabled(true);
    debugLog("sync", "failed", { reason: "token ya29.abcdef revoked for dana@acme.example" });
    expect(debugLogText()).not.toMatch(/ya29|dana@|acme\.example/);
    expect(debugLogText()).toContain("[token]");
    expect(debugLogText()).toContain("[email]");
  });

  it("Clear empties it and tells subscribers at once", () => {
    setDebugLogEnabled(true);
    let calls = 0;
    const unsubscribe = subscribeDebugLog(() => (calls += 1));
    debugLog("notify", "posted", { count: 2 });
    clearDebugLog();
    expect(calls).toBe(1);
    unsubscribe();
    debugLog("notify", "posted", { count: 1 });
    expect(calls).toBe(1);
    expect(debugLogLines()).toHaveLength(1);
  });

  it("tells subscribers about a burst of lines once, not once per line", () => {
    vi.useFakeTimers();
    setDebugLogEnabled(true);
    let calls = 0;
    const unsubscribe = subscribeDebugLog(() => (calls += 1));
    for (let i = 0; i < 500; i++) debugLog("sync", "tick", { n: i });
    expect(calls).toBe(0);
    vi.advanceTimersByTime(NOTIFY_DELAY_MS);
    expect(calls).toBe(1);
    expect(debugLogLines()).toHaveLength(501); // and the debug-log-on line
    unsubscribe();
  });

  it("holds ten thousand lines and copies them all quickly", () => {
    setDebugLogEnabled(true);
    for (let i = 0; i < DEBUG_LOG_CAP * 2; i++) debugLog("auth", "listener-request", { n: i, path: "/winnow-oauth", query: "state,code" });
    expect(debugLogSize()).toBe(DEBUG_LOG_CAP);
    const started = performance.now();
    const text = debugLogText();
    expect(performance.now() - started).toBeLessThan(500);
    expect(text.split("\n")).toHaveLength(DEBUG_LOG_CAP);
    // The viewer draws only the newest few hundred.
    const visible = visibleDebugText(debugLogLines());
    expect(visible.split("\n")).toHaveLength(300);
    expect(visible.endsWith(`n=${DEBUG_LOG_CAP * 2 - 1} path=/winnow-oauth query=state,code`)).toBe(true);
  });

  it("never keeps sign-in secrets by their field names", () => {
    expect(redactValue("code", "4/0AVMBsJh")).toBe("[code: 10 chars]");
    expect(redactValue("state", "abc")).toBe("[state: 3 chars]");
    expect(redactValue("verifier", "xyz")).toBe("[verifier: 3 chars]");
    expect(redactValue("clientSecret", "GOCSPX-1")).toBe("[clientSecret: 8 chars]");
  });

  it("starts with a line saying it is on", () => {
    setDebugLogEnabled(true);
    expect(debugLogLines()[0]).toMatch(/ app debug-log-on cap=10000 native=false$/);
  });
});

describe("Native lines", () => {
  it("merge in timestamp order with the web lines", () => {
    setDebugLogEnabled(true);
    clearDebugLog();
    debugLog("auth", "redirect-wait-start", {}, Date.UTC(2026, 9, 27, 15, 0, 0));
    debugLog("app", "visibility", { visibility: "visible" }, Date.UTC(2026, 9, 27, 15, 0, 30));
    mergeNativeDebugLines([
      "2026-10-27T15:00:10.000Z auth rust:listener-request n=1 method=GET path=/winnow-oauth query=state,code",
      "2026-10-27T15:00:10.005Z auth rust:listener-callback n=1 outcome=code",
    ]);
    const events = debugLogLines().map((line) => line.split(" ")[2]);
    expect(events).toEqual(["redirect-wait-start", "rust:listener-request", "rust:listener-callback", "visibility"]);
  });

  it("are scrubbed again on the way in", () => {
    mergeNativeDebugLines(["2026-10-27T15:00:00.000Z auth rust:oops reason=ya29.leakedtoken who=dana@acme.example\nsecond"]);
    const text = debugLogText();
    expect(text).not.toMatch(/ya29|dana@|\n/);
    expect(text).toContain("[token]");
  });

  it("are drained through the bridge, which follows the switch", async () => {
    const setEnabled = vi.fn();
    const drain = vi.fn(async () => ["2026-10-27T15:00:00.000Z auth rust:listener-bound addr=127.0.0.1:43817"]);
    setNativeDebugBridge({ setEnabled, drain });
    setDebugLogEnabled(true);
    expect(setEnabled).toHaveBeenLastCalledWith(true);
    await syncNativeDebugLog();
    expect(debugLogText()).toContain("rust:listener-bound addr=127.0.0.1:43817");
    setDebugLogEnabled(false);
    expect(setEnabled).toHaveBeenLastCalledWith(false);
  });

  it("a bridge that fails costs nothing", async () => {
    setNativeDebugBridge({ setEnabled: () => Promise.reject(new Error("no command")), drain: () => Promise.reject(new Error("no command")) });
    setDebugLogEnabled(true);
    await expect(syncNativeDebugLog()).resolves.toBeUndefined();
  });
});

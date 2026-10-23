import { afterEach, describe, expect, it } from "vitest";
import {
  DEBUG_LOG_CAP,
  clearDebugLog,
  debugLog,
  debugLogLines,
  debugLogText,
  redactValue,
  setDebugLogEnabled,
  subscribeDebugLog,
} from "./debugLog";

afterEach(() => {
  setDebugLogEnabled(false);
  clearDebugLog();
});

describe("Debug log", () => {
  it("records nothing while it is off", () => {
    debugLog("sync", "start", { initial: false });
    expect(debugLogLines()).toEqual([]);
  });

  it("records area, event, ids, counts and timings while it is on", () => {
    setDebugLogEnabled(true);
    debugLog("sync", "done", { ms: 412, fetched: 37, failed: 0, history: "1234567" }, Date.UTC(2026, 9, 23, 19, 0, 0));
    expect(debugLogLines()).toEqual(["2026-10-23T19:00:00.000Z sync done ms=412 fetched=37 failed=0 history=1234567"]);
  });

  it("stops again when turned off, keeping what is there", () => {
    setDebugLogEnabled(true);
    debugLog("updates", "check", { manual: true });
    setDebugLogEnabled(false);
    debugLog("updates", "check", { manual: false });
    expect(debugLogLines()).toHaveLength(1);
  });

  it("keeps at most the cap, dropping the oldest", () => {
    setDebugLogEnabled(true);
    for (let i = 0; i < DEBUG_LOG_CAP + 25; i++) debugLog("notify", "posted", { n: i });
    const kept = debugLogLines();
    expect(DEBUG_LOG_CAP).toBe(1000);
    expect(kept).toHaveLength(DEBUG_LOG_CAP);
    expect(kept[0]).toMatch(/ n=25$/);
    expect(kept.at(-1)).toMatch(/ n=1024$/);
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

  it("Clear empties it and tells subscribers", () => {
    setDebugLogEnabled(true);
    let calls = 0;
    const unsubscribe = subscribeDebugLog(() => (calls += 1));
    debugLog("notify", "posted", { count: 2 });
    clearDebugLog();
    unsubscribe();
    debugLog("notify", "posted", { count: 1 });
    expect(calls).toBe(2);
    expect(debugLogLines()).toHaveLength(1);
  });
});

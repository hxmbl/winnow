import { afterEach, describe, expect, it, vi } from "vitest";
import { clearDebugLog, debugLogText, setDebugLogEnabled } from "./debugLog";
import { describeError, installLifecycleDebugLog } from "./lifecycle";

/** A minimal event target that records listeners and can fire them. */
function target<T extends object>(extra: T = {} as T) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return Object.assign(extra, {
    addEventListener(type: string, listener: (event: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
    fire(type: string, event: object = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event as Event);
    },
    count() {
      return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
    },
  });
}

afterEach(() => {
  setDebugLogEnabled(false);
  clearDebugLog();
});

describe("App lifecycle in the debug log", () => {
  it("records going to the background and back, and drains the native log on return", () => {
    setDebugLogEnabled(true);
    const doc = target({ visibilityState: "visible" });
    const win = target();
    const onForeground = vi.fn();
    const uninstall = installLifecycleDebugLog(onForeground, { document: doc, window: win, navigator: { onLine: true } });

    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    doc.fire("freeze");
    doc.fire("resume");
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    win.fire("offline");
    win.fire("online");

    const log = debugLogText();
    expect(log).toMatch(/app lifecycle-logging visibility=visible online=true/);
    expect(log).toMatch(/app visibility visibility=hidden/);
    expect(log).toMatch(/app frozen/);
    expect(log).toMatch(/app resumed/);
    expect(log).toMatch(/app visibility visibility=visible/);
    expect(log).toMatch(/network offline/);
    expect(log).toMatch(/network online/);
    // Resume and becoming visible both count as coming back.
    expect(onForeground).toHaveBeenCalledTimes(2);

    uninstall();
    expect(doc.count() + win.count()).toBe(0);
  });

  it("records stray errors by type, redacted, without a stack", () => {
    setDebugLogEnabled(true);
    const win = target();
    installLifecycleDebugLog(() => undefined, { window: win, document: target({ visibilityState: "visible" }) });

    const error = new TypeError("Failed to fetch for dana@acme.example");
    win.fire("error", { error, filename: "http://tauri.localhost/assets/index-abc.js?v=1", lineno: 12 });
    win.fire("unhandledrejection", { reason: new Error("token ya29.secretvalue expired") });

    const log = debugLogText();
    expect(log).toMatch(/app uncaught-error kind=TypeError reason="Failed to fetch for \[email\]" where=index-abc\.js line=12/);
    expect(log).toMatch(/app unhandled-rejection kind=Error reason="token \[token\] expired"/);
    expect(log).not.toMatch(/dana@|ya29|tauri\.localhost|at \w+/);
  });

  it("records nothing while the log is off", () => {
    const doc = target({ visibilityState: "visible" });
    installLifecycleDebugLog(() => undefined, { document: doc, window: target() });
    doc.fire("visibilitychange");
    expect(debugLogText()).toBe("");
  });

  it("describes any thrown value", () => {
    expect(describeError(new RangeError("x"))).toEqual({ kind: "RangeError", message: "x" });
    expect(describeError("plain")).toEqual({ kind: "string", message: "plain" });
    expect(describeError(null)).toEqual({ kind: "null" });
    expect(describeError(42)).toEqual({ kind: "number" });
  });
});

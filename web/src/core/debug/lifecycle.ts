/**
 * App lifecycle and stray errors, for Dev Options → Debug log.
 *
 * What the page itself can see: visibility (on Android, whether Winnow or the browser
 * is in front), the Page Lifecycle `freeze`/`resume` events, focus, `pageshow` /
 * `pagehide`, online/offline, and errors nothing caught. Each is one line, written
 * only while the log is on (`debugLog` is a no-op otherwise). Error lines keep the
 * error's type and a redacted message, never a stack.
 *
 * Coming back to the front also drains the native shell's lines (`onForeground`):
 * whatever Rust recorded while the WebView was paused behind the browser lands in the
 * log in time order.
 */

import { debugLog } from "./debugLog";

type Target = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
};

export type LifecycleEnv = {
  window?: Target;
  document?: Target & { visibilityState?: string };
  navigator?: { onLine?: boolean };
};

function defaultEnv(): LifecycleEnv {
  return {
    window: globalThis.window as unknown as Target | undefined,
    document: globalThis.document as unknown as LifecycleEnv["document"],
    navigator: globalThis.navigator,
  };
}

/** The last path segment of a script URL: where, without the host or a query. */
function scriptName(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length === 0) return undefined;
  const path = url.split(/[?#]/)[0];
  return path.slice(path.lastIndexOf("/") + 1) || undefined;
}

/** An error's type and message, for a log line (the message is redacted by `debugLog`). */
export function describeError(error: unknown): { kind: string; message?: string } {
  if (error instanceof Error) return { kind: error.name || "Error", message: error.message };
  if (typeof error === "string") return { kind: "string", message: error };
  return { kind: error === null ? "null" : typeof error };
}

/**
 * Start logging; returns the uninstall. `onForeground` runs when the page becomes
 * visible, resumes or gains focus.
 */
export function installLifecycleDebugLog(onForeground: () => void = () => undefined, env: LifecycleEnv = defaultEnv()): () => void {
  const removers: Array<() => void> = [];
  const on = (target: Target | undefined, type: string, listener: (event: Event) => void) => {
    if (!target) return;
    target.addEventListener(type, listener);
    removers.push(() => target.removeEventListener(type, listener));
  };
  const doc = env.document;

  on(doc, "visibilitychange", () => {
    const state = doc?.visibilityState ?? "unknown";
    debugLog("app", "visibility", { visibility: state });
    if (state === "visible") onForeground();
  });
  on(doc, "freeze", () => debugLog("app", "frozen"));
  on(doc, "resume", () => {
    debugLog("app", "resumed");
    onForeground();
  });
  on(env.window, "focus", () => {
    debugLog("app", "focus", { focused: true });
    onForeground();
  });
  on(env.window, "blur", () => debugLog("app", "focus", { focused: false }));
  on(env.window, "pageshow", (event) => debugLog("app", "pageshow", { persisted: (event as PageTransitionEvent).persisted === true }));
  on(env.window, "pagehide", (event) => debugLog("app", "pagehide", { persisted: (event as PageTransitionEvent).persisted === true }));
  on(env.window, "online", () => debugLog("network", "online"));
  on(env.window, "offline", () => debugLog("network", "offline"));
  on(env.window, "error", (event) => {
    const e = event as ErrorEvent;
    const { kind, message } = e.error !== undefined ? describeError(e.error) : { kind: "error", message: e.message };
    debugLog("app", "uncaught-error", { kind, reason: message, where: scriptName(e.filename), line: e.lineno || undefined });
  });
  on(env.window, "unhandledrejection", (event) => {
    const { kind, message } = describeError((event as PromiseRejectionEvent).reason);
    debugLog("app", "unhandled-rejection", { kind, reason: message });
  });

  debugLog("app", "lifecycle-logging", {
    visibility: doc?.visibilityState ?? "unknown",
    online: env.navigator?.onLine ?? null,
  });
  return () => {
    for (const remove of removers.splice(0)) remove();
  };
}

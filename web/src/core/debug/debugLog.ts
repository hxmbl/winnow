/**
 * Dev Options → Debug log: an in-memory record of sign-in, sync, network, update,
 * notification and app lifecycle events, for reading back (and copying) when something
 * misbehaves.
 *
 * - **Only while the switch is on.** `setDebugLogEnabled(false)` (the default, and what
 *   Hide Dev Options leaves) makes `debugLog` a no-op; nothing is recorded in between.
 *   The switch reaches the native shell too (`setNativeDebugBridge`), which records
 *   only while it is on.
 * - **Memory only.** At most `DEBUG_LOG_CAP` lines, oldest dropped first; never written
 *   to storage, never sent anywhere, gone when the app closes. Copy and Clear in
 *   Settings are the only ways out.
 * - **Both sides in one log.** The native shell (Rust: the sign-in listener, the
 *   Custom Tab, window and deep-link events) keeps its own lines until they are drained
 *   in here (`syncNativeDebugLog`), merged by timestamp. Native lines read
 *   `… <area> rust:<event> …`.
 * - **Redacted at the door.** Callers pass ids, counts, kinds, paths and timings; every
 *   value still goes through `redactValue`, which replaces email addresses, anything
 *   shaped like a token or key, and long free text (message content) before it is
 *   kept. A field whose name says it is content or a secret (`subject`, `body`, `code`,
 *   `token`, …) is never kept at all, only its length. Native lines are redacted in
 *   Rust and scrubbed again here.
 */

export const DEBUG_LOG_CAP = 10_000;

export type DebugArea = "sync" | "updates" | "notify" | "offline" | "auth" | "app" | "network";

export type DebugFields = Record<string, string | number | boolean | null | undefined>;

/** How the native shell's half of the log is reached; `desktop.ts` installs it. */
export type NativeDebugBridge = {
  setEnabled(on: boolean): Promise<unknown> | void;
  /** The native lines recorded since the last drain, oldest first. */
  drain(): Promise<readonly string[]>;
};

let enabled = false;
/** Oldest first. May run a little past the cap between trims; `snapshot` never does. */
let buffer: string[] = [];
let snapshot: readonly string[] = [];
let dirty = false;
const listeners = new Set<() => void>();
let bridge: NativeDebugBridge | null = null;

/** Listeners hear about a burst of lines once, this long after its first line. */
export const NOTIFY_DELAY_MS = 100;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNotify(): void {
  dirty = true;
  if (listeners.size === 0 || notifyTimer !== null) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const listener of listeners) listener();
  }, NOTIFY_DELAY_MS);
}

function notifyNow(): void {
  dirty = true;
  if (notifyTimer !== null) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  for (const listener of listeners) listener();
}

/** Drop the oldest lines once the buffer is a tenth over the cap: amortised O(1). */
function trim(): void {
  if (buffer.length > DEBUG_LOG_CAP + DEBUG_LOG_CAP / 10) buffer = buffer.slice(buffer.length - DEBUG_LOG_CAP);
}

/** Turn recording on or off (Dev Options → Debug log). Turning it off keeps what is there. */
export function setDebugLogEnabled(on: boolean): void {
  const changed = on !== enabled;
  enabled = on;
  if (changed && bridge) void Promise.resolve(bridge.setEnabled(on)).catch(() => undefined);
  if (changed && on) debugLog("app", "debug-log-on", { cap: DEBUG_LOG_CAP, native: bridge !== null });
}

export function debugLogEnabled(): boolean {
  return enabled;
}

/**
 * Connect the native shell's half of the log. Tells it the current switch, so a log
 * turned on before the bridge existed records natively too.
 */
export function setNativeDebugBridge(next: NativeDebugBridge | null): void {
  bridge = next;
  if (next && enabled) void Promise.resolve(next.setEnabled(true)).catch(() => undefined);
}

/** Pull the native lines waiting in the shell into the log. Never throws. */
export async function syncNativeDebugLog(): Promise<void> {
  if (!bridge) return;
  try {
    mergeNativeDebugLines(await bridge.drain());
  } catch {
    // The shell could not answer (it is shutting down, or this build has no bridge):
    // its lines stay where they are until the next drain.
  }
}

const EMAIL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** OAuth access and refresh tokens, JWTs, `Bearer …`, and any long key-like run. */
const TOKEN = /\b(?:ya29\.[\w.-]+|1\/\/[\w.-]+|Bearer\s+\S+|eyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9_-]{32,})/g;
/** Field names whose values are content or secrets, never kept. */
const CONTENT_FIELD =
  /^(subject|body|snippet|text|content|html|preview|name|from|to|address|email|token|secret|password|code|verifier|state|clientSecret|refreshToken|accessToken)$/i;
/** Free text longer than this is treated as content. */
const MAX_TEXT = 80;
/** A native line longer than this is cut: Rust keeps its fields short, so it is not one of ours. */
const MAX_NATIVE_LINE = 600;

/** One value, made safe to keep. */
export function redactValue(key: string, value: DebugFields[string]): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (CONTENT_FIELD.test(key)) return `[${key}: ${value.length} chars]`;
  const scrubbed = value.replace(TOKEN, "[token]").replace(EMAIL, "[email]");
  if (scrubbed.length > MAX_TEXT) return `[text: ${value.length} chars]`;
  return /\s/.test(scrubbed) ? JSON.stringify(scrubbed) : scrubbed;
}

/** Record one event, if the log is on. */
export function debugLog(area: DebugArea, event: string, fields: DebugFields = {}, now: number = Date.now()): void {
  if (!enabled) return;
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${redactValue(key, value)}`);
  const safeEvent = redactValue("event", event);
  buffer.push(`${new Date(now).toISOString()} ${area} ${safeEvent}${parts.length ? ` ${parts.join(" ")}` : ""}`);
  trim();
  scheduleNotify();
}

/** The leading ISO timestamp both sides write, or "" for a line without one. */
function stampOf(line: string): string {
  const space = line.indexOf(" ");
  return space > 0 ? line.slice(0, space) : "";
}

/**
 * Add lines the native shell recorded (already redacted in Rust; scrubbed again here),
 * in timestamp order with the lines already kept. Accepted while the switch is off
 * too: they were recorded while it was on.
 */
export function mergeNativeDebugLines(lines: readonly unknown[]): void {
  const incoming = lines
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .map((line) => (line.length > MAX_NATIVE_LINE ? `${line.slice(0, MAX_NATIVE_LINE)}…` : line))
    .map((line) => line.replace(/[\r\n]+/g, " ").replace(TOKEN, "[token]").replace(EMAIL, "[email]"));
  if (incoming.length === 0) return;

  const lastKept = buffer.length > 0 ? stampOf(buffer[buffer.length - 1]) : "";
  buffer.push(...incoming);
  // Native lines are usually older than the newest web line (they waited in the shell
  // while the WebView was paused), so sort the tail they landed in. Stable, so lines
  // with the same millisecond keep their order.
  if (lastKept && incoming.some((line) => stampOf(line) < lastKept)) {
    const window = Math.min(buffer.length, incoming.length * 4 + 2_000);
    const tail = buffer.slice(buffer.length - window).sort((a, b) => (stampOf(a) < stampOf(b) ? -1 : stampOf(a) > stampOf(b) ? 1 : 0));
    buffer.splice(buffer.length - window, window, ...tail);
  }
  if (buffer.length > DEBUG_LOG_CAP) buffer = buffer.slice(buffer.length - DEBUG_LOG_CAP);
  scheduleNotify();
}

/** The lines, oldest first, at most the cap. A new array after every change, so React can compare. */
export function debugLogLines(): readonly string[] {
  if (dirty) {
    snapshot = buffer.length > DEBUG_LOG_CAP ? buffer.slice(buffer.length - DEBUG_LOG_CAP) : buffer.slice();
    dirty = false;
  }
  return snapshot;
}

/** How many lines are kept, without copying them. */
export function debugLogSize(): number {
  return Math.min(buffer.length, DEBUG_LOG_CAP);
}

/** How many of the newest lines Settings draws (Copy takes them all). */
export const DEBUG_LOG_SHOWN = 300;

/** The text Settings draws: the newest `shown` lines. */
export function visibleDebugText(lines: readonly string[], shown = DEBUG_LOG_SHOWN): string {
  if (lines.length === 0) return "Nothing recorded yet.";
  return (lines.length > shown ? lines.slice(lines.length - shown) : lines).join("\n");
}

/** The whole log as text, for Copy. */
export function debugLogText(): string {
  return debugLogLines().join("\n");
}

export function clearDebugLog(): void {
  buffer = [];
  notifyNow();
}

/** Called after changes (a burst of lines once, `NOTIFY_DELAY_MS` later); returns the unsubscribe. For `useSyncExternalStore`. */
export function subscribeDebugLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

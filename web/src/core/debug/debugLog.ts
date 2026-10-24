/**
 * Dev Options → Debug log: a small in-memory record of sync, update and notification
 * events, for reading back (and copying) when something misbehaves.
 *
 * - **Only while the switch is on.** `setDebugLogEnabled(false)` (the default, and what
 *   Hide Dev Options leaves) makes `debugLog` a no-op; nothing is recorded in between.
 * - **Memory only.** A ring of at most `DEBUG_LOG_CAP` lines, oldest dropped first; never
 *   written to storage, never sent anywhere, gone when the app closes. Copy and Clear in
 *   Settings are the only ways out.
 * - **Redacted at the door.** Callers pass ids, counts, kinds and timings; every value
 *   still goes through `redactValue`, which replaces email addresses, anything shaped
 *   like a token or key, and long free text (message content) before it is kept. A field
 *   whose name says it is content (`subject`, `body`, `snippet`, `text`, …) is never
 *   kept at all, only its length.
 */

export const DEBUG_LOG_CAP = 2_000;

export type DebugArea = "sync" | "updates" | "notify" | "offline";

export type DebugFields = Record<string, string | number | boolean | null | undefined>;

let enabled = false;
let lines: string[] = [];
const listeners = new Set<() => void>();

/** Turn recording on or off (Dev Options → Debug log). Turning it off keeps what is there. */
export function setDebugLogEnabled(on: boolean): void {
  enabled = on;
}

export function debugLogEnabled(): boolean {
  return enabled;
}

const EMAIL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/** OAuth access and refresh tokens, JWTs, `Bearer …`, and any long key-like run. */
const TOKEN = /\b(?:ya29\.[\w.-]+|1\/\/[\w.-]+|Bearer\s+\S+|eyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9_-]{32,})/g;
/** Field names whose values are content, never kept. */
const CONTENT_FIELD = /^(subject|body|snippet|text|content|html|preview|name|from|to|address|email|token|secret|password|code)$/i;
/** Free text longer than this is treated as content. */
const MAX_TEXT = 80;

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
  const line = `${new Date(now).toISOString()} ${area} ${safeEvent}${parts.length ? ` ${parts.join(" ")}` : ""}`;
  lines = lines.length >= DEBUG_LOG_CAP ? [...lines.slice(lines.length - DEBUG_LOG_CAP + 1), line] : [...lines, line];
  for (const listener of listeners) listener();
}

/** The lines, oldest first. A new array whenever one is added, so React can compare. */
export function debugLogLines(): readonly string[] {
  return lines;
}

/** The whole log as text, for Copy. */
export function debugLogText(): string {
  return lines.join("\n");
}

export function clearDebugLog(): void {
  lines = [];
  for (const listener of listeners) listener();
}

/** Called after every change; returns the unsubscribe. For `useSyncExternalStore`. */
export function subscribeDebugLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

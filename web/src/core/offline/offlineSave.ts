/**
 * "Save this mailbox offline": the decision, and what the store needs from a backend to
 * act on it.
 *
 * The question is the one Winnow already asked ("This is a large mailbox, Winnow requires
 * them to be saved, are you sure you would like to save this?", `STORAGE_PROMPT`), and
 * Save now does what it says: the mailbox goes to the account's IndexedDB database
 * instead of a ~5 MB `localStorage` key, and every message's body and its attachments up
 * to 10 MB are downloaded in the background (`downloader.ts`).
 *
 * When it is asked: once an account's mailbox has `LARGE_MAILBOX` messages or more and
 * nobody has answered yet, or whenever the mailbox could not be written at all. A smaller
 * mailbox is saved without asking (a few hundred messages is a few MB). "Not now" asks
 * again next launch, as before. The answer is per account (`winnow.offlineSave.v1@<id>`)
 * and can be changed in Settings → Privacy → Offline mail, which also shows the progress
 * and has Remove downloads.
 */

import type { LoadedBody } from "../model/email";
import type { DownloadProgress } from "./downloader";
import type { OfflineStore } from "./offlineStore";

/** From this many messages the mailbox counts as large, and Save is asked rather than assumed. */
export const LARGE_MAILBOX = 2000;

export type OfflineDecision = "on" | "off";

/** What a backend offers for offline saving. Absent: the host has no durable store (or the demo). */
export interface OfflineBackend {
  store: OfflineStore;
  /** The account's answer, or `null` before one. */
  decision(): OfflineDecision | null;
  setDecision(value: OfflineDecision): void;
  /** A message's whole body for saving: the cache's copy when it has one, else one `format=full`. */
  body(gmailId: string): Promise<LoadedBody>;
  attachment(gmailId: string, attachmentId: string): Promise<Uint8Array>;
  /** Remove messages Gmail says are gone, from the cache and the offline store. */
  gone(gmailIds: readonly string[]): Promise<void>;
}

/** What Settings shows. */
export type OfflineView = {
  /** False on a host without IndexedDB, in the demo, and signed out. */
  available: boolean;
  decision: OfflineDecision | null;
  progress: DownloadProgress | null;
};

export const OFFLINE_UNAVAILABLE: OfflineView = { available: false, decision: null, progress: null };

/** Whether to ask, save without asking, or leave it as answered. */
export function offlineNextStep(
  decision: OfflineDecision | null,
  messages: number,
  options: { declined: boolean; unpersisted: boolean },
): "ask" | "save" | "keep" {
  if (decision !== null) return "keep";
  if (options.declined) return "keep";
  if (options.unpersisted || messages >= LARGE_MAILBOX) return "ask";
  return "save";
}

/** "Saved 1,234 of 1,500 · 312 MB", with what it is waiting for when paused. */
export function offlineSummary(view: OfflineView, format: (n: number) => string = (n) => n.toLocaleString("en-GB")): string {
  const progress = view.progress;
  if (!view.available) return "Not available here";
  if (!progress) return view.decision === "on" ? "Starting…" : "Not saved offline";
  const size = formatBytes(progress.bytes);
  const counts = `Saved ${format(progress.saved)} of ${format(progress.total)} · ${size}`;
  if (view.decision !== "on") return progress.saved > 0 ? counts : "Not saved offline";
  if (progress.state === "paused") {
    const why =
      progress.reason === "offline"
        ? "waiting for a connection"
        : progress.reason === "hidden"
          ? "paused while Winnow is in the background"
          : progress.reason === "metered"
            ? "paused on a metered connection"
            : progress.reason === "battery"
              ? "paused to save battery"
              : "paused, will retry";
    return `${counts} · ${why}`;
  }
  if (progress.state === "done" || progress.saved >= progress.total) return `${counts} · up to date`;
  return counts;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${bytes > 0 ? Math.max(1, Math.round(bytes / 1024)) : 0} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

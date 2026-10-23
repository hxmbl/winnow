/**
 * Saving the whole mailbox for offline reading.
 *
 * Sync is metadata-first: a message's body is fetched when it is opened (plus a few
 * neighbours and the newest unread), so most of the mailbox was never on the device.
 * This walks the local set — every message the cache holds, which is the inbox in full
 * and the newest 500 of the other views — newest first, and stores each one's whole body
 * and its attachments up to `ATTACHMENT_DOWNLOAD_CAP` in the account's offline store
 * (`offlineStore.ts`). Bigger attachments stay on demand.
 *
 * - **Never in the way.** Each request goes through `schedule`, the store's body queue at
 *   its lowest priority, one at a time: an opened message jumps every queued download
 *   and waits behind at most the one already on the wire.
 * - **Resumable.** What is saved is the store's own index, so a restart simply starts
 *   again with what is not there yet. Nothing is downloaded twice: a body the cache
 *   already holds (it was opened) is taken from the cache (`DownloadSource.body`).
 * - **Polite.** `conditions` is asked before every message; offline, hidden on a phone,
 *   a metered or data-saver connection, or a low battery pauses the walk until the next
 *   `start()` (every sync calls it).
 * - **Honest about deletions.** A 404 means the message is gone on the server, and it is
 *   removed locally (`DownloadSource.gone`). Any other failure deletes nothing: a
 *   network or auth error pauses everything, anything else skips that one message for
 *   this session.
 */

import { GmailHttpError } from "../gmail/dto";
import type { LoadedBody } from "../model/email";
import { bodyBytes, type OfflineStore, type SavedFile, type StoredBody } from "./offlineStore";

/** Attachments up to this size are saved with their message; bigger ones download when opened. */
export const ATTACHMENT_DOWNLOAD_CAP = 10 * 1024 * 1024;

/** Messages per batch: progress is published and the Debug log written once a batch. */
export const DOWNLOAD_BATCH = 25;

/** Why downloading is waiting. */
export type DownloadBlock = "offline" | "hidden" | "metered" | "battery";

export type DownloadState = "idle" | "running" | "paused" | "done" | "stopped";

export type DownloadProgress = {
  state: DownloadState;
  /** Messages of the local set saved offline. */
  saved: number;
  /** Messages in the local set. */
  total: number;
  /** Bytes the offline copy takes (bodies and files). */
  bytes: number;
  /** Set while paused: what it waits for, or `error` (retried on the next sync). */
  reason?: DownloadBlock | "error";
  /** Messages that could not be saved this session (retried after a restart). */
  failed: number;
};

export type DownloadTarget = { gmailId: string; receivedAt: number };

export interface DownloadSource {
  /** The local set, in any order. */
  targets(): readonly DownloadTarget[];
  /** A message's whole body: the cache's copy when it has one, the network otherwise. */
  body(gmailId: string): Promise<LoadedBody>;
  attachment(gmailId: string, attachmentId: string): Promise<Uint8Array>;
  /** Gmail answered 404: the message is gone, so remove it everywhere locally. */
  gone(gmailId: string): Promise<void>;
}

export type DownloaderOptions = {
  store: OfflineStore;
  source: DownloadSource;
  /** Run one request at the lowest priority of the shared queue. */
  schedule: <T>(task: () => Promise<T>) => Promise<T>;
  /** What stops downloading right now, or `null`. */
  conditions?: () => DownloadBlock | null;
  onProgress?: (progress: DownloadProgress) => void;
  log?: (event: string, data: Record<string, unknown>) => void;
  now?: () => number;
  attachmentCap?: number;
  batchSize?: number;
};

/** A failure that says nothing about the message itself: stop and try again later. */
function isTransient(error: unknown): boolean {
  if (!(error instanceof GmailHttpError)) return true;
  return error.status === 0 || error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500;
}

function isGone(error: unknown): boolean {
  return error instanceof GmailHttpError && error.status === 404;
}

/**
 * Which of a message's attachments are saved with it: those with an id, up to the cap.
 * Inline images count — a `cid:` picture is part of reading the message offline.
 */
export function attachmentsToSave(body: LoadedBody, cap = ATTACHMENT_DOWNLOAD_CAP): { save: string[]; skipped: number } {
  const save: string[] = [];
  let skipped = 0;
  for (const attachment of body.attachments) {
    if (attachment.id && attachment.size <= cap) save.push(attachment.id);
    else skipped += 1;
  }
  return { save, skipped };
}

export class OfflineDownloader {
  private generation = 0;
  private running: Promise<void> | null = null;
  private failedIds = new Set<string>();
  private current: DownloadProgress = { state: "idle", saved: 0, total: 0, bytes: 0, failed: 0 };

  constructor(private readonly options: DownloaderOptions) {}

  progress(): DownloadProgress {
    return this.current;
  }

  /** Start, or resume after a pause. Does nothing while a walk is already running. */
  start(): Promise<void> {
    if (this.running) return this.running;
    const generation = this.generation;
    this.running = this.run(generation).finally(() => {
      if (this.generation === generation) this.running = null;
    });
    return this.running;
  }

  /** Stop: sign-out, an account switch, "Remove downloads", or saving turned off. */
  stop(): void {
    this.generation += 1;
    this.running = null;
    this.publish({ ...this.current, state: "stopped", reason: undefined });
  }

  /** Re-read the counts without downloading (after a sync changed the local set). */
  async refreshCounts(): Promise<DownloadProgress> {
    const generation = this.generation;
    const counts = await this.counts();
    if (generation === this.generation) this.publish({ ...this.current, ...counts.progress });
    return this.current;
  }

  private publish(progress: DownloadProgress): void {
    this.current = progress;
    this.options.onProgress?.(progress);
  }

  private async counts(): Promise<{ progress: Pick<DownloadProgress, "saved" | "total" | "bytes">; saved: Set<string> }> {
    const targets = this.options.source.targets();
    const [saved, stats] = await Promise.all([this.options.store.savedIds(), this.options.store.stats()]);
    let count = 0;
    for (const target of targets) if (saved.has(target.gmailId)) count += 1;
    return { progress: { saved: count, total: targets.length, bytes: stats.bytes }, saved };
  }

  private async run(generation: number): Promise<void> {
    const live = () => generation === this.generation;
    const { store, source, schedule } = this.options;
    const cap = this.options.attachmentCap ?? ATTACHMENT_DOWNLOAD_CAP;
    const batchSize = Math.max(1, this.options.batchSize ?? DOWNLOAD_BATCH);
    const now = this.options.now ?? Date.now;
    const log = this.options.log ?? (() => undefined);

    let counts;
    try {
      counts = await this.counts();
    } catch {
      if (live()) this.publish({ ...this.current, state: "paused", reason: "error" });
      return;
    }
    if (!live()) return;
    let { saved: savedCount, total, bytes } = counts.progress;
    const queue = [...source.targets()]
      .filter((target) => !counts.saved.has(target.gmailId) && !this.failedIds.has(target.gmailId))
      .sort((a, b) => b.receivedAt - a.receivedAt);

    const state = (patch: Partial<DownloadProgress>): void => {
      this.publish({ saved: savedCount, total, bytes, failed: this.failedIds.size, state: "running", ...patch });
    };

    if (queue.length === 0) {
      state({ state: "done" });
      return;
    }
    state({});

    for (let start = 0; start < queue.length; start += batchSize) {
      const batch = queue.slice(start, start + batchSize);
      const began = now();
      let batchSaved = 0;
      let batchBytes = 0;
      let batchGone = 0;
      let batchFailed = 0;

      for (const target of batch) {
        const block = this.options.conditions?.() ?? null;
        if (block) {
          if (live()) state({ state: "paused", reason: block });
          log("paused", { reason: block, saved: savedCount, total });
          return;
        }
        if (!live()) return;
        try {
          const body = await schedule(() => source.body(target.gmailId));
          if (!live()) return;
          const { save, skipped: overCap } = attachmentsToSave(body, cap);
          const files: SavedFile[] = [];
          let skipped = overCap;
          for (const attachmentId of save) {
            try {
              files.push({ attachmentId, bytes: await schedule(() => source.attachment(target.gmailId, attachmentId)) });
            } catch (error) {
              // The message is fine; this one file stays on demand. A transient failure
              // still stops the walk, so the message is retried whole next time.
              if (isTransient(error)) throw error;
              skipped += 1;
            }
            if (!live()) return;
          }
          const record: StoredBody = {
            gmailId: target.gmailId,
            body: body.body,
            ...(body.bodySource ? { bodySource: body.bodySource } : {}),
            ...(body.bodyHtml !== undefined ? { bodyHtml: body.bodyHtml } : {}),
            attachments: body.attachments,
            files: files.map((file) => file.attachmentId),
            skipped,
            bytes: bodyBytes(body, files),
            savedAt: now(),
          };
          // Gone (signed out, switched, removed) while this was on the wire: not ours to write.
          if (!live()) return;
          await store.putBody(record, files);
          savedCount += 1;
          bytes += record.bytes;
          batchSaved += 1;
          batchBytes += record.bytes;
        } catch (error) {
          if (!live()) return;
          if (isGone(error)) {
            await source.gone(target.gmailId).catch(() => undefined);
            total = Math.max(0, total - 1);
            batchGone += 1;
            continue;
          }
          if (isTransient(error)) {
            state({ state: "paused", reason: "error" });
            log("paused", { reason: "error", status: error instanceof GmailHttpError ? error.status : 0, saved: savedCount, total });
            return;
          }
          this.failedIds.add(target.gmailId);
          batchFailed += 1;
        }
      }

      if (!live()) return;
      log("batch", {
        saved: batchSaved,
        gone: batchGone,
        failed: batchFailed,
        bytes: batchBytes,
        ms: now() - began,
        done: savedCount,
        total,
      });
      state({});
    }

    if (live()) state({ state: "done" });
  }
}

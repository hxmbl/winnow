/**
 * Keeping the local cache in step with Gmail.
 *
 * Two strategies:
 *
 * - **Full sync** — first sign-in, or a cursor Gmail no longer retains. Pages
 *   four views (`in:inbox`, everything else, `in:trash`, `in:spam`), fetches
 *   each message, and files it by its labels.
 * - **Incremental sync** — every refresh after that. Reads `history.list` since
 *   the stored cursor and re-fetches each touched message *whole*.
 *
 * Decisions: re-fetch, never apply the diff (cannot drift). Cursor only advances
 * on a clean run (avoids skipping failed messages). A 404 from history means full
 * rebuild (cursor expired).
 */

import type { Email, Mailbox } from "../model/email";
import type { GmailClient } from "./client";
import { MAX_PAGE_SIZE } from "./client";
import { GmailHttpError, LABEL, type GmailMessage } from "./dto";
import { mailboxFor, toEmail } from "./mapper";

/** Where the cache keeps its messages. */
export interface MailboxCache {
  all(): Promise<Email[]>;
  upsert(emails: readonly Email[]): Promise<void>;
  remove(gmailIds: readonly string[]): Promise<void>;
  gmailIds(): Promise<string[]>;
  /** Drop everything not in `gmailIds`. */
  keepOnly(gmailIds: readonly string[]): Promise<void>;
  /** Replace the whole cache. */
  replace(emails: readonly Email[]): Promise<void>;
  clear(): Promise<void>;
  /**
   * Force any coalesced write to land, throwing if it could not be persisted.
   * Optional. If present, the sync engine calls it before recording a cursor —
   * the cursor asserts "the cache is a faithful copy as of this history id", so
   * the cache must have reached disk.
   */
  flush?(): Promise<void>;
}

/** Where the sync cursor lives. Opaque, and not a secret. */
export interface CursorStore {
  read(): Promise<string | null>;
  write(historyId: string): Promise<void>;
  clear(): Promise<void>;
}

/** The five views a full sync pages through, and how far each goes. */
const VIEWS: readonly { query: string; cap: number }[] = [
  // The inbox is the product; it is never truncated.
  { query: "in:inbox", cap: Number.POSITIVE_INFINITY },
  // Sent mail, because the composer suggests people you have written to and a recipient
  // list needs the other side of a conversation to have any. Capped like the rest: this
  // is a contact source, not an export, and a 12,000-message sent folder would cost the
  // cache far more than it adds.
  { query: "in:sent", cap: 500 },
  // "Archived" means All Mail minus the folder-ish buckets: drafts and spam.
  { query: "-in:inbox -in:trash -in:sent -in:draft -in:spam", cap: 500 },
  { query: "in:trash", cap: 500 },
  { query: "in:spam", cap: 500 },
];

/** Pagination guard. A runaway token would otherwise page until the token expired. */
const MAX_PAGES = 200;

/** Cache writes are batched: 25 per round-trip is the sweet spot on IndexedDB. */
const BATCH_SIZE = 25;

export type SyncProgress = {
  phase: "idle" | "full" | "incremental" | "sending";
  /** 0–1, or `null` when the total is not yet known. */
  fraction: number | null;
  /** How many messages have landed in the cache this run. */
  fetched: number;
  /** How many could not be downloaded. Non-zero means the view is incomplete. */
  failed: number;
};

export type SyncResult = {
  /** Every message now known, newest first. */
  emails: Email[];
  /** Messages that failed. Surfaced so the user is not shown a false "all caught up". */
  failed: number;
  /** True when a view hit its cap, so the cache is a triage set, not an export. */
  truncated: boolean;
  /**
   * True when the mailbox could not be written to persistent storage.
   *
   * Distinct from `failed` (messages that could not be *fetched*): sync succeeded
   * but the offline cache was not persisted.
   */
  cacheUnpersisted: boolean;
  durationMs: number;
};

export type SyncOptions = {
  client: GmailClient;
  cache: MailboxCache;
  cursor: CursorStore;
  onProgress?: (progress: SyncProgress) => void;
  /** Injected in tests; defaults to the wall clock. */
  now?: () => number;
  /** Injected in tests to avoid a real sleep between pages. */
  sleep?: (ms: number) => Promise<void>;
};

export class GmailSyncEngine {
  constructor(private readonly options: SyncOptions) {}

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  /**
   * Refresh, choosing the strategy from whether a cursor exists.
   *
   * `onProgress` is accepted per-call because the reporter is the caller's; both
   * strategies are given the caller's reporter.
   */
  async sync(options: { onProgress?: (progress: SyncProgress) => void } = {}): Promise<SyncResult> {
    const cursor = await this.options.cursor.read();
    const reporter = options.onProgress ?? this.options.onProgress;
    return cursor ? this.incremental(reporter) : this.full(reporter);
  }

  /** Discard the cursor and rebuild every view. */
  async rebuild(options: { onProgress?: (progress: SyncProgress) => void } = {}): Promise<SyncResult> {
    await this.options.cursor.clear();
    return this.full(options.onProgress ?? this.options.onProgress);
  }

  /**
   * Page every view, fetch every message, and replace the cache.
   *
   * Replaces rather than merges: `seen` is the complete truth about what exists,
   * so anything else in the cache was deleted server-side and must go.
   */
  async full(onProgress?: (progress: SyncProgress) => void): Promise<SyncResult> {
    const started = this.now();
    await this.options.cursor.clear();
    const report = (progress: SyncProgress): void => {
      (onProgress ?? this.options.onProgress)?.(progress);
    };
    report({ phase: "full", fraction: 0, fetched: 0, failed: 0 });

    // Taken before the pages, so anything that arrives while paging is picked up
    // by the next incremental sync rather than being missed.
    const profile = await this.options.client.profile();

    const seen = new Set<string>();
    const fetched = new Set<string>();
    const byMailbox = new Map<Mailbox, Email[]>();
    let failed = 0;
    let truncated = false;

    for (const view of VIEWS) {
      const stubs: { id: string; threadId?: string }[] = [];
      let pageToken: string | undefined;
      let collected = 0;
      let page = 0;

      do {
        page += 1;
        if (page > MAX_PAGES) {
          truncated = true;
          break;
        }

        const response = await this.options.client.list(
          view.query,
          Math.min(MAX_PAGE_SIZE, view.cap - collected),
          pageToken,
        );

        if (response.messages) {
          stubs.push(...response.messages);
          collected += response.messages.length;
        }

        pageToken = response.nextPageToken;

        // Hitting the cap with pages still available means the view is larger
        // than we are willing to walk.
        if (collected >= view.cap && pageToken) {
          truncated = true;
          pageToken = undefined;
        }
      } while (pageToken);

      let batch: Email[] = [];

      for (const stub of stubs) {
        if (fetched.has(stub.id)) continue;
        const outcome = await this.fetchOne(stub.id);
        if (outcome.kind === "success") {
          fetched.add(stub.id);
          seen.add(stub.id);
          const bucket = byMailbox.get(outcome.email.mailbox) ?? [];
          bucket.push(outcome.email);
          byMailbox.set(outcome.email.mailbox, bucket);
          batch.push(outcome.email);
          if (batch.length >= BATCH_SIZE) {
            await this.options.cache.upsert(batch);
            batch = [];
          }
          report({
            phase: "full",
            fraction: null,
            fetched: seen.size,
            failed,
          });
        } else if (outcome.kind === "failed") {
          // Marked as seen even though it failed: the cache already holds a
          // copy from a previous sync, and dropping it here would delete mail
          // the user can still read.
          seen.add(stub.id);
          failed += 1;
        }
        // `missing` is deliberately *not* seen: the message is gone, and the
        // cache must forget it.
      }

      if (batch.length > 0) await this.options.cache.upsert(batch);
    }

    // Anything a view could not walk needs an individual fetch, or it would
    // fall out of `seen` and be deleted as if it had been removed.
    if (truncated) {
      for (const id of await this.options.cache.gmailIds()) {
        if (fetched.has(id)) continue;
        const outcome = await this.fetchOne(id);
        if (outcome.kind === "success") {
          seen.add(id);
          await this.options.cache.upsert([outcome.email]);
        } else if (outcome.kind === "failed") {
          seen.add(id);
          failed += 1;
        }
      }
    }

    await this.options.cache.keepOnly([...seen]);

    // Land any coalesced write before making a claim that depends on it. A
    // cursor means "the cache is a faithful copy as of this history id", so
    // writing one over a cache that failed to persist would leave the next launch
    // believing a mailbox it does not have.
    const cacheUnpersisted = !(await this.flushCache());

    // The cursor is only trustworthy when the cache is a faithful copy.
    if (failed === 0 && !cacheUnpersisted) await this.options.cursor.write(profile.historyId);

    const emails = await this.options.cache.all();
    report({ phase: "idle", fraction: 1, fetched: seen.size, failed });

    return { emails, failed, truncated, cacheUnpersisted, durationMs: this.now() - started };
  }

  /** Apply everything that changed since the stored cursor. */
  async incremental(onProgress?: (progress: SyncProgress) => void): Promise<SyncResult> {
    const started = this.now();
    const startHistoryId = await this.options.cursor.read();
    if (!startHistoryId) return this.full(onProgress);

    const report = (progress: SyncProgress): void => {
      (onProgress ?? this.options.onProgress)?.(progress);
    };
    report({ phase: "incremental", fraction: 0, fetched: 0, failed: 0 });

    let failed = 0;
    let fetched = 0;
    let pageToken: string | undefined;
    let latestHistoryId = startHistoryId;
    let page = 0;

    try {
      do {
        page += 1;
        if (page > MAX_PAGES) break;

        const response = await this.options.client.history(startHistoryId, pageToken);
        for (const record of response.history ?? []) {
          failed += await this.applyRecord(record);
          fetched += 1;
        }
        pageToken = response.nextPageToken;
        if (response.historyId) latestHistoryId = response.historyId;
        report({ phase: "incremental", fraction: null, fetched, failed });
      } while (pageToken);
    } catch (error) {
      // The cursor is older than Google retains. The only correct response is
      // a full rebuild; carrying on would silently skip everything since.
      if (error instanceof GmailHttpError && error.status === 404) {
        return this.full(onProgress);
      }
      throw error;
    }

    const cacheUnpersisted = !(await this.flushCache());

    if (failed === 0 && !cacheUnpersisted) await this.options.cursor.write(latestHistoryId);

    const emails = await this.options.cache.all();
    report({ phase: "idle", fraction: 1, fetched, failed });

    return { emails, failed, truncated: false, cacheUnpersisted, durationMs: this.now() - started };
  }

  /**
   * Land any coalesced cache write. Returns `false` if it could not be persisted.
   *
   * Reported rather than thrown: messages arrived fine, session is usable in
   * memory. Better to report that the offline cache did not save than to fail
   * the whole sync.
   */
  private async flushCache(): Promise<boolean> {
    try {
      await this.options.cache.flush?.();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Apply one history record.
   *
   * Every touched message is re-fetched whole rather than having its labels
   * patched, so the resulting state is always derived from what the server says.
   * Returns how many fetches failed.
   */
  private async applyRecord(record: {
    messagesDeleted?: { id: string }[];
    messagesAdded?: { message: { id: string } }[];
    labelsAdded?: { message: { id: string } }[];
    labelsRemoved?: { message: { id: string } }[];
  }): Promise<number> {
    const deleted: string[] = [];
    const touched = new Set<string>();

    for (const entry of record.messagesDeleted ?? []) deleted.push(entry.id);
    for (const entry of record.messagesAdded ?? []) touched.add(entry.message.id);
    for (const entry of record.labelsAdded ?? []) touched.add(entry.message.id);
    for (const entry of record.labelsRemoved ?? []) touched.add(entry.message.id);

    if (deleted.length > 0) await this.options.cache.remove(deleted);

    let failed = 0;
    for (const id of touched) {
      const outcome = await this.fetchOne(id);
      if (outcome.kind === "success") await this.options.cache.upsert([outcome.email]);
      else if (outcome.kind === "missing") await this.options.cache.remove([id]);
      else failed += 1;
    }
    return failed;
  }

  /**
   * Fetch one message.
   *
   * `missing` and `failed` are kept apart on purpose. Missing means the server
   * says it does not exist, so the cache must forget it. Failed means we could
   * not find out, so the cached copy has to stand — treating a network blip as
   * a deletion loses mail.
   */
  private async fetchOne(
    id: string,
  ): Promise<{ kind: "success"; email: Email } | { kind: "missing" } | { kind: "failed" }> {
    let message: GmailMessage;
    try {
      message = await this.options.client.message(id);
    } catch (error) {
      if (error instanceof GmailHttpError && error.status === 404) return { kind: "missing" };
      return { kind: "failed" };
    }

    // Mail the user wrote is a tracked view now — the composer's recipient suggestions
    // are built from the other side of the conversations in it. Drafts are not: a draft
    // is an unfinished thing, and half of them have no recipients at all.
    const labels = message.labelIds ?? [];
    const tracked =
      labels.includes(LABEL.inbox) ||
      labels.includes(LABEL.trash) ||
      labels.includes(LABEL.spam) ||
      labels.includes(LABEL.sent);
    if (!tracked && labels.includes(LABEL.draft)) {
      return { kind: "missing" };
    }

    const email = toEmail(message);
    if (!email) return { kind: "missing" };

    // `mailboxFor` reads the labels, so a message that arrived in the archived
    // view with an INBOX label mid-move still lands correctly.
    return { kind: "success", email: { ...email, mailbox: mailboxFor(labels) } };
  }
}

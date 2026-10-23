/**
 * Keeping the local cache in step with Gmail.
 *
 * Two strategies:
 *
 * - **Full sync** — first sign-in, or a cursor Gmail no longer retains. Pages
 *   five views (`in:inbox`, sent, everything else, `in:trash`, `in:spam`), fetches
 *   each message, and files it by its labels.
 * - **Incremental sync** — every refresh after that. Reads `history.list` since
 *   the stored cursor and re-fetches each touched message.
 *
 * Both fetch **metadata only** (labels, the headers in `METADATA_HEADERS`, snippet,
 * size), through a bounded pool of `FETCH_CONCURRENCY` requests. Bodies are loaded
 * lazily — the reader asks for the one it opens and the store prefetches a few around
 * it — and a body already in the cache is kept across re-fetches (`keepLoadedBody`),
 * since Gmail never changes a message's content after delivery.
 *
 * The inbox is walked first and published as soon as it has something to show
 * (`onPartial`), then periodically while it fills; the other views follow in the
 * background. The quota bucket in `client.ts` is still the real ceiling — 20 units per
 * `messages.get` against 6,000 a minute — so on a big mailbox what the user feels is
 * the inbox appearing in seconds, not the whole sync finishing sooner.
 *
 * Decisions: re-fetch, never apply the diff (cannot drift). Cursor only advances
 * on a clean run (avoids skipping failed messages). A 404 from history means full
 * rebuild (cursor expired).
 */

import { keepLoadedBody, type Email } from "../model/email";
import type { GmailClient, MessageFormat } from "./client";
import { MAX_PAGE_SIZE } from "./client";
import { GmailHttpError, LABEL, type GmailMessage } from "./dto";
import { mailboxFor, toEmail } from "./mapper";
import { mapPool } from "./pool";

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

/** The reconciliation's listing gives up (deleting nothing) past this many pages: 200,000 ids. */
export const RECONCILE_MAX_PAGES = 400;

/** A reconciliation that would remove more than this share of a local set checks first. */
export const RECONCILE_SUSPECT_SHARE = 0.5;

/** …when at least this many messages would go. */
export const RECONCILE_SUSPECT_MIN = 20;

/** How many of the missing ids are fetched to confirm a suspicious listing. */
export const RECONCILE_PROBES = 3;

/** What one reconciliation did. `skipped` removes nothing. */
export type ReconcileResult =
  | { kind: "done"; removed: string[]; listed: number }
  | { kind: "skipped"; reason: "error" | "too-large" | "inconsistent" };

/** Cache writes are batched: 25 per round-trip is the sweet spot on IndexedDB. */
const BATCH_SIZE = 25;

/**
 * How many message fetches are in flight at once.
 *
 * Eight hides the round trip (one request per ~100ms of latency becomes eight) while
 * staying far below the point where Gmail starts answering concurrent requests from
 * one user with 429s. The quota bucket paces them regardless.
 */
export const FETCH_CONCURRENCY = 8;

/** How many inbox messages make a first screen worth showing. */
export const FIRST_PAINT = 25;

/** How often a filling inbox is re-published, at most. */
export const PARTIAL_INTERVAL_MS = 750;

/** Which half of a full sync a progress event belongs to. */
export type SyncStage = "inbox" | "other";

export type SyncProgress = {
  phase: "idle" | "full" | "incremental" | "sending";
  /** 0–1, or `null` when the total is not yet known. */
  fraction: number | null;
  /** How many messages have landed in the cache this run. */
  fetched: number;
  /** How many could not be downloaded. Non-zero means the view is incomplete. */
  failed: number;
  /** Full sync only: the inbox, or the views behind it. */
  stage?: SyncStage;
  /** Messages the run knows it has to fetch so far, when known. */
  total?: number;
};

/**
 * The mailbox so far, mid-sync. Called with the cache's current contents, newest first.
 *
 * The inbox-first contract: the first call comes as soon as the inbox has
 * `FIRST_PAINT` messages (or is complete), so the list can render while the rest of the
 * sync carries on.
 */
export type PartialListener = (emails: Email[]) => void;

export type SyncCallbacks = {
  onProgress?: (progress: SyncProgress) => void;
  onPartial?: PartialListener;
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
  /**
   * Which strategy ran. A full sync rebuilds the local set from the server's listing,
   * so it counts as a reconciliation (`reconcile`) as well.
   */
  mode?: "full" | "incremental";
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
  /** Message fetches in flight at once. Defaults to `FETCH_CONCURRENCY`; 1 is the old serial engine. */
  concurrency?: number;
};

type FetchOutcome = { kind: "success"; email: Email } | { kind: "missing" } | { kind: "failed" };

export class GmailSyncEngine {
  constructor(private readonly options: SyncOptions) {}

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  /**
   * Refresh, choosing the strategy from whether a cursor exists.
   *
   * The callbacks are accepted per-call because the reporter is the caller's; both
   * strategies are given the caller's reporter.
   */
  async sync(options: SyncCallbacks = {}): Promise<SyncResult> {
    const cursor = await this.options.cursor.read();
    const reporter = options.onProgress ?? this.options.onProgress;
    return cursor ? this.incremental(reporter, options.onPartial) : this.full(reporter, options.onPartial);
  }

  /** Discard the cursor and rebuild every view. */
  async rebuild(options: SyncCallbacks = {}): Promise<SyncResult> {
    await this.options.cursor.clear();
    return this.full(options.onProgress ?? this.options.onProgress, options.onPartial);
  }

  private get concurrency(): number {
    return this.options.concurrency ?? FETCH_CONCURRENCY;
  }

  /**
   * Page every view, fetch every message, and replace the cache.
   *
   * Replaces rather than merges: `seen` is the complete truth about what exists,
   * so anything else in the cache was deleted server-side and must go. Bodies the
   * cache already holds survive (`keepLoadedBody`).
   */
  async full(onProgress?: (progress: SyncProgress) => void, onPartial?: PartialListener): Promise<SyncResult> {
    const started = this.now();
    await this.options.cursor.clear();
    const report = (progress: SyncProgress): void => {
      (onProgress ?? this.options.onProgress)?.(progress);
    };
    report({ phase: "full", fraction: 0, fetched: 0, failed: 0, stage: "inbox" });

    // Taken before the pages, so anything that arrives while paging is picked up
    // by the next incremental sync rather than being missed.
    const profile = await this.options.client.profile();

    // What the cache holds now, so a re-fetched message keeps a body it already has.
    const previous = new Map((await this.options.cache.all()).map((email) => [email.gmailId, email]));

    const seen = new Set<string>();
    const fetched = new Set<string>();
    let failed = 0;
    let truncated = false;
    let total = 0;
    let batch: Email[] = [];

    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      await this.options.cache.upsert(rows);
    };

    // Inbox-first publishing. `lastPartial` is null until the first screen has gone out.
    let lastPartial: number | null = null;
    const publish = async (): Promise<void> => {
      if (!onPartial) return;
      await flushBatch();
      lastPartial = this.now();
      onPartial(await this.options.cache.all());
    };

    for (const [index, view] of VIEWS.entries()) {
      const stage: SyncStage = index === 0 ? "inbox" : "other";
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

      // Once per id per view, and not again once a view has it. A message that failed
      // in an earlier view is tried again here, as the serial engine did.
      const ids = [...new Set(stubs.map((stub) => stub.id))].filter((id) => !fetched.has(id));
      total += ids.length;
      let inboxFetched = 0;

      await mapPool(
        ids,
        this.concurrency,
        (id) => this.fetchOne(id, previous.get(id)),
        async (outcome, id) => {
          if (outcome.kind === "success") {
            fetched.add(id);
            seen.add(id);
            batch.push(outcome.email);
            if (batch.length >= BATCH_SIZE) await flushBatch();
            if (stage === "inbox") inboxFetched += 1;
            report({
              phase: "full",
              fraction: total > 0 ? seen.size / total : null,
              fetched: seen.size,
              failed,
              stage,
              total,
            });
            if (stage === "inbox" && onPartial) {
              const due =
                lastPartial === null
                  ? inboxFetched >= FIRST_PAINT
                  : this.now() - lastPartial >= PARTIAL_INTERVAL_MS;
              if (due) await publish();
            }
          } else if (outcome.kind === "failed") {
            // Marked as seen even though it failed: the cache already holds a
            // copy from a previous sync, and dropping it here would delete mail
            // the user can still read.
            seen.add(id);
            failed += 1;
          }
          // `missing` is deliberately *not* seen: the message is gone, and the
          // cache must forget it.
        },
      );

      await flushBatch();
      // The inbox is complete: show all of it now, whatever the throttle says, and
      // again after each background view so its mailbox fills in too.
      await publish();
    }

    // Anything a view could not walk needs an individual fetch, or it would
    // fall out of `seen` and be deleted as if it had been removed.
    if (truncated) {
      const leftovers = (await this.options.cache.gmailIds()).filter((id) => !fetched.has(id));
      await mapPool(
        leftovers,
        this.concurrency,
        (id) => this.fetchOne(id, previous.get(id)),
        async (outcome, id) => {
          if (outcome.kind === "success") {
            seen.add(id);
            batch.push(outcome.email);
            if (batch.length >= BATCH_SIZE) await flushBatch();
          } else if (outcome.kind === "failed") {
            seen.add(id);
            failed += 1;
          }
        },
      );
      await flushBatch();
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
    report({ phase: "idle", fraction: 1, fetched: seen.size, failed, total });

    return { emails, failed, truncated, cacheUnpersisted, durationMs: this.now() - started, mode: "full" };
  }

  /**
   * Apply everything that changed since the stored cursor.
   *
   * Every page is read first and the touched ids are collected across all of them,
   * so a message starred, read and archived in three records is fetched once, not
   * three times — then the fetches go through the pool like a full sync's.
   */
  async incremental(
    onProgress?: (progress: SyncProgress) => void,
    onPartial?: PartialListener,
  ): Promise<SyncResult> {
    const started = this.now();
    const startHistoryId = await this.options.cursor.read();
    if (!startHistoryId) return this.full(onProgress, onPartial);

    const report = (progress: SyncProgress): void => {
      (onProgress ?? this.options.onProgress)?.(progress);
    };
    report({ phase: "incremental", fraction: 0, fetched: 0, failed: 0 });

    let pageToken: string | undefined;
    let latestHistoryId = startHistoryId;
    let page = 0;
    const deleted = new Set<string>();
    const touched = new Set<string>();

    try {
      do {
        page += 1;
        if (page > MAX_PAGES) break;

        const response = await this.options.client.history(startHistoryId, pageToken);
        for (const record of response.history ?? []) collectRecord(record, deleted, touched);
        pageToken = response.nextPageToken;
        if (response.historyId) latestHistoryId = response.historyId;
      } while (pageToken);
    } catch (error) {
      // The cursor is older than Google retains. The only correct response is
      // a full rebuild; carrying on would silently skip everything since.
      if (error instanceof GmailHttpError && error.status === 404) {
        return this.full(onProgress, onPartial);
      }
      throw error;
    }

    // Gmail ids are never reused, so a deleted message is gone for good — there is
    // nothing a later record could have done to it worth a fetch.
    for (const id of deleted) touched.delete(id);
    if (deleted.size > 0) await this.options.cache.remove([...deleted]);

    const previous = touched.size > 0
      ? new Map((await this.options.cache.all()).map((email) => [email.gmailId, email]))
      : new Map<string, Email>();

    let failed = 0;
    let fetched = 0;
    const total = touched.size;
    let batch: Email[] = [];
    const gone: string[] = [];

    await mapPool(
      [...touched],
      this.concurrency,
      (id) => this.fetchOne(id, previous.get(id)),
      async (outcome, id) => {
        if (outcome.kind === "success") {
          fetched += 1;
          batch.push(outcome.email);
          if (batch.length >= BATCH_SIZE) {
            const rows = batch;
            batch = [];
            await this.options.cache.upsert(rows);
          }
        } else if (outcome.kind === "missing") {
          gone.push(id);
        } else {
          failed += 1;
        }
        report({ phase: "incremental", fraction: total > 0 ? (fetched + failed + gone.length) / total : null, fetched, failed, total });
      },
    );
    if (batch.length > 0) await this.options.cache.upsert(batch);
    if (gone.length > 0) await this.options.cache.remove(gone);

    const cacheUnpersisted = !(await this.flushCache());

    if (failed === 0 && !cacheUnpersisted) await this.options.cursor.write(latestHistoryId);

    const emails = await this.options.cache.all();
    report({ phase: "idle", fraction: 1, fetched, failed, total });

    return { emails, failed, truncated: false, cacheUnpersisted, durationMs: this.now() - started, mode: "incremental" };
  }

  /**
   * Remove local copies of mail the server no longer has: the full id reconciliation.
   *
   * History (`incremental`) already reports `messagesDeleted`, and a re-fetch answering
   * 404 already removes its message; this is the backstop for everything history can
   * miss (a cursor gap, a deletion made while another client held the history window,
   * an expunge). It lists every id in the account, trash and spam included, ids only,
   * and removes each local message absent from that listing.
   *
   * Deleting is only ever done on a definite answer:
   *
   *   - Any error while listing (network, auth, quota, a 5xx) skips the run; nothing
   *     is removed.
   *   - A listing that runs past `RECONCILE_MAX_PAGES` is incomplete and skips.
   *   - Only messages the cache held *before* the listing began are judged, so mail a
   *     concurrent sync wrote meanwhile is never mistaken for missing.
   *   - A suspicious answer (more than `RECONCILE_SUSPECT_SHARE` of a sizeable local set
   *     missing) is checked first: a few of the missing ids are fetched, and unless each
   *     answers 404 the run skips, so a truncated or wrong listing cannot empty the
   *     mailbox.
   */
  async reconcile(): Promise<ReconcileResult> {
    const local = new Set(await this.options.cache.gmailIds());
    if (local.size === 0) return { kind: "done", removed: [], listed: 0 };

    const listed = new Set<string>();
    let pageToken: string | undefined;
    let page = 0;
    try {
      do {
        page += 1;
        if (page > RECONCILE_MAX_PAGES) return { kind: "skipped", reason: "too-large" };
        const response = await this.options.client.listAllIds(pageToken);
        for (const message of response.messages ?? []) listed.add(message.id);
        pageToken = response.nextPageToken || undefined;
      } while (pageToken);
    } catch {
      return { kind: "skipped", reason: "error" };
    }

    const missing = [...local].filter((id) => !listed.has(id));
    if (missing.length === 0) return { kind: "done", removed: [], listed: listed.size };

    if (missing.length >= RECONCILE_SUSPECT_MIN && missing.length > local.size * RECONCILE_SUSPECT_SHARE) {
      for (const id of missing.slice(0, RECONCILE_PROBES)) {
        try {
          await this.options.client.message(id, "minimal");
          return { kind: "skipped", reason: "inconsistent" };
        } catch (error) {
          if (!(error instanceof GmailHttpError && error.status === 404)) return { kind: "skipped", reason: "error" };
        }
      }
    }

    await this.options.cache.remove(missing);
    await this.flushCache();
    return { kind: "done", removed: missing, listed: listed.size };
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
   * Fetch one message's metadata.
   *
   * `missing` and `failed` are kept apart on purpose. Missing means the server
   * says it does not exist, so the cache must forget it. Failed means we could
   * not find out, so the cached copy has to stand — treating a network blip as
   * a deletion loses mail.
   *
   * `cached` is the copy already held, whose body (if loaded) the fresh copy keeps.
   */
  private async fetchOne(id: string, cached?: Email): Promise<FetchOutcome> {
    const format: MessageFormat = "metadata";
    let message: GmailMessage;
    try {
      message = await this.options.client.message(id, format);
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

    const email = toEmail(message, { format });
    if (!email) return { kind: "missing" };

    // `mailboxFor` reads the labels, so a message that arrived in the archived
    // view with an INBOX label mid-move still lands correctly.
    return { kind: "success", email: keepLoadedBody({ ...email, mailbox: mailboxFor(labels) }, cached) };
  }
}

/** Fold one history record into the run's deleted and touched sets. */
function collectRecord(
  record: {
    /**
     * Gmail's shape is `{ message: { id, threadId } }` (HistoryMessageDeleted). Before
     * 1.5.6 this read `entry.id`, which Gmail never sends, so a permanent deletion was
     * only noticed by the next full rebuild. The bare `{ id }` is still accepted.
     */
    messagesDeleted?: { message?: { id: string }; id?: string }[];
    messagesAdded?: { message: { id: string } }[];
    labelsAdded?: { message: { id: string } }[];
    labelsRemoved?: { message: { id: string } }[];
  },
  deleted: Set<string>,
  touched: Set<string>,
): void {
  for (const entry of record.messagesDeleted ?? []) {
    const id = entry.message?.id ?? entry.id;
    if (id) deleted.add(id);
  }
  for (const entry of record.messagesAdded ?? []) touched.add(entry.message.id);
  for (const entry of record.labelsAdded ?? []) touched.add(entry.message.id);
  for (const entry of record.labelsRemoved ?? []) touched.add(entry.message.id);
}

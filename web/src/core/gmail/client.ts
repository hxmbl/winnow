/**
 * The Gmail API client: a thin, typed wrapper over `fetch`.
 *
 * Two behaviours live here because they are properties of the wire:
 *
 *   - **Quota pacing.** Every request waits for a token bucket of Gmail quota
 *     units (`QuotaBucket` / `costOf`), so a sync paging a large mailbox cannot
 *     spend a minute's budget on back-to-back `messages.get` calls.
 *   - **Retries only where a retry can help.** A 429, or a 403 carrying a quota
 *     reason, is retried with bounded backoff. A 401 triggers one forced token
 *     refresh and one retry — a second 401 means the grant is gone.
 *
 * No batching, caching or retry queue; those belong to `sync.ts`.
 */

import {
  GMAIL_API,
  GmailError,
  GmailHttpError,
  LABEL,
  base64UrlEncode,
  type GmailAttachmentResponse,
  type GmailHistoryResponse,
  type GmailListResponse,
  type GmailMessage,
  type GmailProfile,
  type GmailSendResponse,
} from "./dto";
import { decodeBody, htmlPart } from "./mapper";

/** Gmail's maximum page size. Asking for more is silently clamped. */
export const MAX_PAGE_SIZE = 200;

/**
 * Gmail's per-user quota is 6,000 units/minute. The bucket refills at 4,800/min
 * and bursts to 1,000, so a burst plus a full minute of refill stays under the
 * limit. One account per client means one bucket per user.
 */
export const UNITS_PER_MINUTE = 4_800;
export const BURST_UNITS = 1_000;

/** How many times a rate-limited request is replayed before the error surfaces. */
export const MAX_RETRIES = 6;

/** The backoff is capped; beyond this, Google has said "leave it alone". */
export const MAX_BACKOFF_MS = 64_000;

/** A wait. Injectable so tests never sleep on the real clock. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The quota units one request costs, from Gmail's usage-limits table.
 *
 * Unlisted endpoints default to 5, which is correct for `messages.list` and
 * `messages.modify`; over-charging a genuinely pricier endpoint errs on the
 * side of being more polite, never less.
 */
export function costOf(path: string, method: string): number {
  if (method === "POST" && path.endsWith("/send")) return 100;
  if (method === "DELETE") return 10;
  if (path.includes("/attachments/")) return 20;
  // A get of one message or draft, i.e. the `?format=full` requests.
  if (/\/messages\/[^/?]+\?/.test(path) || /\/drafts\/[^/?]+\?/.test(path)) return 20;
  if (path.startsWith("/users/me/history")) return 2;
  if (path.startsWith("/users/me/profile")) return 1;
  return 5;
}

/**
 * Whether a response is Google saying "slow down" rather than "you did
 * something wrong". 429 always is. A 403 is read: most 403s are permissions
 * problems a retry cannot fix, so only the quota/rate reasons in
 * `error.errors[].reason` are treated as retryable.
 */
export function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  try {
    const error = (JSON.parse(body) as {
      error?: { errors?: { reason?: string }[]; message?: unknown };
    }).error;
    const reasons = (error?.errors ?? []).map((entry) => entry.reason ?? "");
    if (reasons.some((reason) => /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(reason))) {
      return true;
    }
    return /quota exceeded|rate limit/i.test(String(error?.message ?? ""));
  } catch {
    return false;
  }
}

/**
 * Exponential backoff with a second of jitter, so a retry loop does not pile
 * every attempt onto the same second. Capped at `MAX_BACKOFF_MS`.
 */
export function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000 + Math.random() * 1000, MAX_BACKOFF_MS);
}

/**
 * A token bucket of Gmail quota units, shared by every request a client makes.
 *
 * It refills at `UNITS_PER_MINUTE` up to a separate burst capacity. `take`
 * acquires before the request goes out, so pacing applies to sync paging and to
 * the burst inside a sync alike.
 *
 * `take` calls are serialised through a promise chain, so two concurrent
 * requests cannot hand each other the same units.
 */
export class QuotaBucket {
  private units: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly unitsPerMinute: number = UNITS_PER_MINUTE,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
    private readonly capacity: number = Math.min(BURST_UNITS, unitsPerMinute),
  ) {
    this.units = capacity;
    this.last = now();
  }

  /** Wait until `cost` units are available, then consume them. */
  take(cost: number): Promise<void> {
    if (cost > this.capacity) {
      return Promise.reject(new RangeError("quota cost exceeds bucket capacity"));
    }
    const next = this.queue.then(async () => {
      for (;;) {
        const now = this.now();
        this.units = Math.min(
          this.capacity,
          this.units + ((now - this.last) / 60_000) * this.unitsPerMinute,
        );
        this.last = now;
        if (this.units >= cost) {
          this.units -= cost;
          return;
        }
        const waitMs = Math.ceil(((cost - this.units) / this.unitsPerMinute) * 60_000);
        await this.sleep(waitMs);
      }
    });
    // A rejected `take` must not poison the chain for the request behind it.
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Empty the bucket after a rate-limit response: Google has decided the
   * minute's budget is spent, and the rest of the burst should stop now rather
   * than spend the *next* minute's refill on the same doomed work.
   */
  drain(): void {
    this.units = 0;
    this.last = this.now();
  }
}

/** The `Authorization` header value, kept in one place. */
export type TokenProvider = () => Promise<string | null>;

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export type GmailClientOptions = {
  /** Injected in tests; defaults to the platform `fetch`. */
  fetchImpl?: FetchLike;
  /**
   * Force a new access token and retry the request once. Supplied by
   * `tokens.ts`; omitted means a 401 is final.
   */
  onUnauthorized?: () => Promise<string | null>;
  /**
   * The quota bucket. Injected in tests to disable pacing or observe drains;
   * production uses one `QuotaBucket` per client.
   */
  bucket?: QuotaBucket;
  /** The clock and the wait, injected in tests so nothing sleeps for real. */
  now?: () => number;
  sleep?: Sleep;
};

export class GmailClient {
  private readonly fetchImpl: FetchLike;
  private readonly onUnauthorized: (() => Promise<string | null>) | undefined;
  private readonly sleep: Sleep;
  private readonly bucket: QuotaBucket;

  constructor(
    private readonly tokenProvider: TokenProvider,
    options: GmailClientOptions = {},
  ) {
    const globalFetch = globalThis.fetch?.bind(globalThis) as FetchLike | undefined;
    const impl = options.fetchImpl ?? globalFetch;
    if (!impl) throw new Error("no fetch implementation available");
    this.fetchImpl = impl;
    this.onUnauthorized = options.onUnauthorized;
    this.sleep = options.sleep ?? realSleep;
    this.bucket = options.bucket ?? new QuotaBucket(UNITS_PER_MINUTE, options.now, this.sleep);
  }

  /**
   * One request: paced by the quota bucket, with bounded retries for rate-limit
   * responses and one transparent retry after a forced token refresh.
   *
   * `allowRetry` is threaded rather than looped so the 401 retry cannot recurse:
   * a refresh that returns another 401 has to surface, not spin. Each rate-limit
   * replay charges the request's quota cost again, because a replayed request is
   * a real request.
   */
  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; allowRetry?: boolean } = {},
  ): Promise<T> {
    const token = await this.tokenProvider();
    if (!token) {
      throw new GmailError("Not signed in to Gmail.", 401, "reauth_required");
    }

    const url = `${GMAIL_API}${path}`;
    const method = init.method ?? "GET";
    const send = async (bearer: string) => {
      for (let attempt = 0; ; attempt += 1) {
        await this.bucket.take(costOf(path, method));
        const response = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${bearer}`,
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        const text = await response.text();
        if (!isRateLimited(response.status, text) || attempt >= MAX_RETRIES) {
          return { response, text };
        }
        // Google has just said the budget is spent. Waiting for the bucket to
        // refill around *this* request would leave the rest of the burst queued
        // behind it anyway, so drain instead and come back after a live-server
        // backoff.
        this.bucket.drain();
        await this.sleep(backoffMs(attempt));
      }
    };

    const { response, text } = await send(token);

    if (response.status === 401 && init.allowRetry !== false && this.onUnauthorized) {
      const refreshed = await this.onUnauthorized();
      if (!refreshed) {
        throw new GmailError("Your Google session has expired. Sign in again.", 401, "reauth_required");
      }
      const retry = await send(refreshed);
      if (!retry.response.ok) {
        throw new GmailHttpError(retry.response.status, retry.text);
      }
      // Same empty-body guard as below: a label modify answers 204, and
      // `JSON.parse("")` on the retry was a SyntaxError reported to the user as a
      // failed star.
      return (retry.text ? JSON.parse(retry.text) : {}) as T;
    }

    if (!response.ok) throw new GmailHttpError(response.status, text);
    // A 204 (the label-modify endpoints) has no body to parse.
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Who is signed in, and the cursor a first sync starts from. */
  async profile(): Promise<GmailProfile> {
    return this.request<GmailProfile>("/users/me/profile");
  }

  /**
   * One page of a search.
   *
   * `pageToken` is passed through untouched, including the empty string, which
   * Gmail treats as "first page" — a distinction the sync engine relies on.
   */
  async list(
    query: string,
    maxResults: number,
    pageToken?: string,
  ): Promise<GmailListResponse> {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
    if (pageToken) params.set("pageToken", pageToken);
    return this.request<GmailListResponse>(`/users/me/messages?${params}`);
  }

  /**
   * A full message, headers and all.
   *
   * `full` rather than `metadata`: the classifier needs the body.
   */
  async message(id: string): Promise<GmailMessage> {
    return this.request<GmailMessage>(`/users/me/messages/${encodeURIComponent(id)}?format=full`);
  }

  /**
   * Just the HTML body of one message, for a message the reader is opening.
   *
   * The same request as `message` — Gmail has no body-only endpoint — but one
   * call per opened message rather than per sync. See `BODY_RETENTION` in the
   * store: the HTML body is 67% of what a message costs to hold and is only ever
   * read for the one on screen.
   */
  async messageBodyHtml(id: string): Promise<string | undefined> {
    const message = await this.message(id);
    const html = htmlPart(message.payload);
    return html ? decodeBody(html.body!.data!) : undefined;
  }

  /**
   * Changes since `startHistoryId`.
   *
   * Every history type is asked for: requesting `messageAdded` alone misses an
   * archive, star, mark-read or delete made elsewhere, and the incremental sync
   * keeps the stale copy forever. This filters what Gmail *returns*, not what
   * it keeps; all four types are retained for the same window, and `sync.ts`
   * applies all four.
   */
  async history(startHistoryId: string, pageToken?: string): Promise<GmailHistoryResponse> {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded,labelsAdded,labelsRemoved,messagesDeleted",
    });
    if (pageToken) params.set("pageToken", pageToken);
    return this.request<GmailHistoryResponse>(`/users/me/history?${params}`);
  }

  /** Add a label. `addLabelIds` is the documented field name for the API. */
  async addLabels(id: string, labelIds: string[]): Promise<void> {
    await this.request(`/users/me/messages/${encodeURIComponent(id)}/modify`, {
      method: "POST",
      body: { addLabelIds: labelIds },
    });
  }

  async removeLabels(id: string, labelIds: string[]): Promise<void> {
    await this.request(`/users/me/messages/${encodeURIComponent(id)}/modify`, {
      method: "POST",
      body: { removeLabelIds: labelIds },
    });
  }

  /** Archive: leave the inbox, keep everything else. */
  async archive(id: string): Promise<void> {
    await this.removeLabels(id, [LABEL.inbox]);
  }

  async markRead(id: string, read: boolean): Promise<void> {
    if (read) await this.removeLabels(id, [LABEL.unread]);
    else await this.addLabels(id, [LABEL.unread]);
  }

  async setStarred(id: string, starred: boolean): Promise<void> {
    if (starred) await this.addLabels(id, [LABEL.starred]);
    else await this.removeLabels(id, [LABEL.starred]);
  }

  async trash(id: string): Promise<void> {
    await this.addLabels(id, [LABEL.trash]);
  }

  async restore(id: string): Promise<void> {
    await this.removeLabels(id, [LABEL.trash]);
    await this.addLabels(id, [LABEL.inbox]);
  }

  async markNotSpam(id: string): Promise<void> {
    await this.removeLabels(id, [LABEL.spam]);
    await this.addLabels(id, [LABEL.inbox]);
  }

  async deletePermanently(id: string): Promise<void> {
    await this.request(`/users/me/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /**
   * Send a raw RFC 822 message. See `mime.ts` for the body.
   *
   * Base64url-encoded here because the API's `raw` field requires it; plain text
   * is accepted only for ASCII and 400s on any non-ASCII header or body. Encoding
   * belongs at the wire so a caller cannot forget it.
   */
  async send(raw: string, threadId?: string): Promise<GmailSendResponse> {
    const body: Record<string, unknown> = { raw: base64UrlEncode(new TextEncoder().encode(raw)) };
    if (threadId) body.threadId = threadId;
    return this.request<GmailSendResponse>("/users/me/messages/send", { method: "POST", body });
  }

  /** Attachment bytes, base64url encoded. */
  async attachment(id: string, attachmentId: string): Promise<GmailAttachmentResponse> {
    return this.request<GmailAttachmentResponse>(
      `/users/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  }

  async draft(id: string): Promise<GmailMessage> {
    return this.request<GmailMessage>(`/users/me/drafts/${encodeURIComponent(id)}?format=full`);
  }

  async listDrafts(maxResults: number, pageToken?: string): Promise<GmailListResponse> {
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (pageToken) params.set("pageToken", pageToken);
    return this.request<GmailListResponse>(`/users/me/drafts?${params}`);
  }
}

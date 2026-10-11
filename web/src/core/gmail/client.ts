/**
 * The Gmail API client.
 *
 * A thin, typed wrapper over `fetch` with two behaviours that live here because
 * they are properties of the wire rather than of any one caller:
 *
 *   - **Quota pacing.** Before each request this layer waits for a token bucket
 *     of Gmail quota units (`QuotaBucket` / `costOf`), so a sync that pages a
 *     large mailbox cannot spend an entire minute's 6,000-unit per-user budget
 *     on back-to-back `messages.get` calls.
 *   - **Retries only where a retry can help.** A 429, or a 403 carrying a quota
 *     reason, is retried with bounded backoff (`isRateLimited` / `backoffMs`),
 *     because that is Google saying "come back later". A 401 triggers exactly
 *     one forced token refresh and one retry — a second 401 means the grant is
 *     gone (revoked, password changed, or the scope changed) and looping would
 *     buy nothing.
 *
 * There is no other cleverness — no batching, no caching, no retry queue.
 * Those belong to `sync.ts`, and keeping them apart means the request layer can
 * be read in one screen.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Gmail/API/GmailClient.swift`.
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
 * Gmail's per-user quota on new projects is 6,000 units/minute (and 1.2M/minute
 * for the whole project, which is not the binding constraint for one person).
 * The bucket refills at 4,800 units/minute and holds at most 1,000 burst units.
 * Even the maximum burst plus a full minute of refill stays below Google's
 * 6,000-unit per-user limit. One account is signed in at a time, so one bucket
 * per client is one bucket per user.
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
 * Costs changed on 1 May 2026: `messages.get` and attachment downloads went
 * from 5 to 20 each, and nothing got cheaper. Anything this client sends that
 * is not named here defaults to 5, which is also the correct cost for
 * `messages.list` and `messages.modify` — so an endpoint left out of the list
 * charges what it actually costs, and an unlisted endpoint that is really more
 * expensive errs on the side of spending: a bucket that over-charges makes the
 * client more polite, never less.
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
 * something wrong". HTTP 429 is that, always. A 403 gets read: most 403s are a
 * permissions problem — a missing scope, an org policy, an admin rule — that
 * retrying won't fix, so only the quota/rate reasons the API reports in
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
 * Exponential backoff with a full second of jitter, so a retry loop does not
 * pile every attempt onto the same second. Capped at `MAX_BACKOFF_MS`.
 */
export function backoffMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000 + Math.random() * 1000, MAX_BACKOFF_MS);
}

/**
 * A token bucket of Gmail quota units, shared by every request a client makes.
 *
 * It refills at `UNITS_PER_MINUTE` per minute up to a separate burst capacity.
 * `take` acquires *before* the request goes out, so the pacing applies to sync
 * paging and to the burst inside a sync alike.
 *
 * `take` calls are serialised through a promise chain: two requests awaiting
 * the bucket simultaneously cannot hand each other the same units.
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
   * Empty the bucket after a rate-limit response: Google has already decided
   * the minute's budget is spent, and the remainder of a burst should stop now
   * rather than spend the *next* minute's refill on the same doomed work.
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
   * `allowRetry` is threaded rather than looped so the 401 retry cannot itself
   * recurse: a refresh that returns another 401 has to surface, not spin. The
   * rate-limit retries are capped at `MAX_RETRIES`, and each replay charges the
   * request's quota cost again, because a replayed request is a real request.
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
        // behind it anyway, so drain instead — everything that follows paces
        // itself, and this request comes back after a live-server backoff.
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
      // Same empty-body guard as the non-retry path below: a label modify answers
      // 204, and `JSON.parse("")` on the retry was a SyntaxError reported to the
      // user as a failed star.
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
   * `full` rather than `metadata`: the classifier needs the body, and fetching
   * it lazily per row would mean a request per visible message.
   */
  async message(id: string): Promise<GmailMessage> {
    return this.request<GmailMessage>(`/users/me/messages/${encodeURIComponent(id)}?format=full`);
  }

  /**
   * Just the HTML body of one message, for a message the reader is opening.
   *
   * The same request as `message` — Gmail has no body-only endpoint — but named for
   * what it is *for*, and that is the whole difference: one call per message on every
   * sync versus one call when a person opens something. See `BODY_RETENTION` in the
   * store. The HTML body is 67% of what a message costs to hold and is only ever read
   * for the one message on screen, so it is the one field worth not keeping.
   */
  async messageBodyHtml(id: string): Promise<string | undefined> {
    const message = await this.message(id);
    const html = htmlPart(message.payload);
    return html ? decodeBody(html.body!.data!) : undefined;
  }

  /**
   * Changes since `startHistoryId`.
   *
   * Every history type is asked for. This used to request `messageAdded` alone,
   * which is the one type a *new* message produces — so an archive, a star, a
   * mark-read or a delete made anywhere else was never reported, and the
   * incremental sync quietly kept the stale copy forever. It is worth being
   * explicit that this is a filter on what Gmail *returns*, not on what Gmail
   * keeps: all four types are retained for the same window, and `sync.ts` already
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
   * The message is base64url-encoded here, because that is what the API's `raw`
   * field requires. It used to be put in the JSON body as plain text, which
   * Gmail accepts for an ASCII-only message and rejects with a 400 as soon as
   * anything in the headers or the body is non-ASCII — that is, for a mail client
   * writing to someone in another language, and it failed on send rather than
   * earlier where it was visible. Encoding belongs at the wire rather than at each
   * caller, because a caller that forgets it fails only on some messages.
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

  /** The whole profile history, for a first sync. */
  async draft(id: string): Promise<GmailMessage> {
    return this.request<GmailMessage>(`/users/me/drafts/${encodeURIComponent(id)}?format=full`);
  }

  async listDrafts(maxResults: number, pageToken?: string): Promise<GmailListResponse> {
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (pageToken) params.set("pageToken", pageToken);
    return this.request<GmailListResponse>(`/users/me/drafts?${params}`);
  }
}

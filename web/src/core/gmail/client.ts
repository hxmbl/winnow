/**
 * The Gmail API client: a thin, typed wrapper over `fetch`.
 *
 * Two behaviours live here because they are properties of the wire:
 *
 *   - **Quota pacing.** Every request waits for a token bucket of Gmail quota
 *     units (`QuotaBucket` / `costOf`), so a sync paging a large mailbox cannot
 *     spend a minute's budget on back-to-back `messages.get` calls.
 *   - **Retries only where a retry can help.** A 429, or a 403 carrying a quota
 *     reason, is retried with bounded exponential backoff and jitter, honouring a
 *     `Retry-After` header when Google sends one. A 5xx is retried a few times
 *     too — Google's own guidance for `backendError` — but without draining the
 *     bucket, because a flaky backend says nothing about quota. A 401 triggers one
 *     forced token refresh and one retry — a second 401 means the grant is gone.
 *
 * Concurrency is the caller's (`pool.ts`, driven by `sync.ts`): every request
 * still goes through the one bucket, so eight in flight spend the same budget
 * as one, just without the round trips in between.
 */

import {
  GMAIL_API,
  GMAIL_UPLOAD_API,
  GmailError,
  GmailHttpError,
  LABEL,
  base64UrlEncode,
  type GmailAttachmentResponse,
  type GmailDraft,
  type GmailDraftList,
  type GmailFullDraft,
  type GmailHistoryResponse,
  type GmailListResponse,
  type GmailMessage,
  type GmailProfile,
  type GmailSendResponse,
} from "./dto";
import { decodeBody, htmlPart } from "./mapper";
import { SNOOZED_LABEL } from "../mail/snooze";

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

/**
 * How many times a 5xx is replayed. Fewer than a rate limit: a backend that fails
 * three times in a row is down, and the sync engine's failure accounting (keep the
 * cached copy, hold the cursor) is the right place for that answer to land.
 */
export const MAX_SERVER_RETRIES = 3;

/**
 * The headers `format=metadata` asks for — everything the list, the classifier,
 * threading and the composer read without a body.
 *
 * `Content-Type` is not here because Gmail reports the top-level MIME type as
 * `payload.mimeType` in every format, which is what the attachment hint reads.
 */
export const METADATA_HEADERS: readonly string[] = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Date",
  "List-Unsubscribe",
  // RFC 8058 one-click: read with List-Unsubscribe into `Email.unsubscribe`.
  "List-Unsubscribe-Post",
  "List-Id",
  "Message-ID",
  "References",
  "In-Reply-To",
];

/** How much of a message to ask for. `metadata` is labels + headers + snippet. */
export type MessageFormat = "full" | "metadata";

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
  // drafts.create 10, drafts.update 15 — the usage-limits table's numbers.
  if (method === "POST" && path === "/users/me/drafts") return 10;
  if (method === "PUT" && path.startsWith("/users/me/drafts/")) return 15;
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

/** A transient server-side failure, worth a short retry. 501 is "not implemented" and is not. */
export function isServerError(status: number): boolean {
  return status >= 500 && status <= 599 && status !== 501;
}

/**
 * `Retry-After`, in milliseconds, or `null` when absent or unreadable.
 *
 * Both RFC 9110 forms are read: delta-seconds (what Google sends) and an HTTP date.
 * Capped at `MAX_BACKOFF_MS` like everything else — a header asking for an hour is
 * a header the sync engine should answer by failing the message, not by hanging.
 */
export function retryAfterMs(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_BACKOFF_MS);
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, at - now), MAX_BACKOFF_MS);
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
/**
 * Every type `history` asks for; see `GmailClient.history`.
 *
 * These are the request enum (`HistoryType`), which is singular. The response's
 * record fields are plural (`messagesAdded`, `labelsAdded`, `labelsRemoved`,
 * `messagesDeleted`); sending those names here is a 400 "Invalid value at
 * 'history_types'".
 */
export const HISTORY_TYPES = ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"] as const;

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
  /** Optional so a test stub can omit it; the platform `fetch` always has it. */
  headers?: { get(name: string): string | null };
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
  private readonly now: () => number;

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
    this.now = options.now ?? Date.now;
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
    init: {
      method?: string;
      body?: unknown;
      allowRetry?: boolean;
      /**
       * Send to the media upload endpoint (`/upload/gmail/v1`) with this body as is,
       * rather than JSON to the API. See `uploadBody`.
       */
      upload?: { contentType: string; body: string };
    } = {},
  ): Promise<T> {
    const token = await this.tokenProvider();
    if (!token) {
      throw new GmailError("Not signed in to Gmail.", 401, "reauth_required");
    }

    const url = `${init.upload ? GMAIL_UPLOAD_API : GMAIL_API}${path}`;
    const method = init.method ?? "GET";
    // An upload is charged as the call it uploads for: `?uploadType=` is not part of it.
    const costPath = init.upload ? path.replace(/\?uploadType=[a-z]+$/, "") : path;
    const send = async (bearer: string) => {
      for (let attempt = 0; ; attempt += 1) {
        await this.bucket.take(costOf(costPath, method));
        const response = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${bearer}`,
            ...(init.upload
              ? { "Content-Type": init.upload.contentType }
              : init.body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
          },
          body: init.upload ? init.upload.body : init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        const text = await response.text();
        const limited = isRateLimited(response.status, text);
        const flaky = !limited && isServerError(response.status);
        if ((!limited && !flaky) || attempt >= (limited ? MAX_RETRIES : MAX_SERVER_RETRIES)) {
          return { response, text };
        }
        // Google has just said the budget is spent. Waiting for the bucket to
        // refill around *this* request would leave the rest of the burst queued
        // behind it anyway, so drain instead and come back after a live-server
        // backoff. A 5xx leaves the bucket alone: it is not a statement about quota.
        if (limited) this.bucket.drain();
        const hinted = retryAfterMs(response.headers?.get("Retry-After"), this.now());
        await this.sleep(Math.max(backoffMs(attempt), hinted ?? 0));
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
   * One message.
   *
   * `full` by default, which is what opening a message needs. The sync engine asks
   * for `metadata` — labels, `METADATA_HEADERS`, snippet, size — and fetches the body
   * lazily. Gmail charges the same 20 units for either; what `metadata` saves is
   * bytes, parse time and cache size, not quota.
   */
  async message(id: string, format: MessageFormat = "full"): Promise<GmailMessage> {
    const params = new URLSearchParams({ format });
    if (format === "metadata") {
      for (const header of METADATA_HEADERS) params.append("metadataHeaders", header);
    }
    return this.request<GmailMessage>(`/users/me/messages/${encodeURIComponent(id)}?${params}`);
  }

  /**
   * One message's whole RFC 5322 source (`format=raw`), for Dev Options → View
   * Original. Base64url as Gmail sends it; `core/mail/rawSource.ts` decodes it. Never
   * rendered, only shown as text.
   */
  async messageRaw(id: string): Promise<string> {
    const message = await this.request<{ raw?: string }>(
      `/users/me/messages/${encodeURIComponent(id)}?format=raw`,
    );
    return message.raw ?? "";
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
    const params = new URLSearchParams({ startHistoryId });
    // A repeated parameter, one per type. Gmail parses `historyTypes` as a repeated
    // enum, so a single comma-joined value is one unknown enum and the call fails
    // with 400 "Invalid value at 'history_types'", which stalls every incremental sync.
    for (const type of HISTORY_TYPES) params.append("historyTypes", type);
    if (pageToken) params.set("pageToken", pageToken);
    return this.request<GmailHistoryResponse>(`/users/me/history?${params}`);
  }

  /** Add a label. `addLabelIds` is the documented field name for the API. */
  async addLabels(id: string, labelIds: string[]): Promise<void> {
    refuseFixedLabels(labelIds);
    await this.request(`/users/me/messages/${encodeURIComponent(id)}/modify`, {
      method: "POST",
      body: { addLabelIds: labelIds },
    });
  }

  async removeLabels(id: string, labelIds: string[]): Promise<void> {
    refuseFixedLabels(labelIds);
    await this.request(`/users/me/messages/${encodeURIComponent(id)}/modify`, {
      method: "POST",
      body: { removeLabelIds: labelIds },
    });
  }

  /**
   * Add and remove labels in one `messages.modify`, for a change that must land together
   * (snoozing: the label on and `INBOX` off).
   */
  async modify(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    refuseFixedLabels([...addLabelIds, ...removeLabelIds]);
    await this.request(`/users/me/messages/${encodeURIComponent(id)}/modify`, {
      method: "POST",
      body: { addLabelIds, removeLabelIds },
    });
  }

  /**
   * The id of Winnow's own label, made if the account has none yet (`labels.list`, then
   * `labels.create`). Only `Winnow/Snoozed`: Winnow does not manage the account's labels
   * (MAP §13a), and this one exists so snoozed mail is visible and recoverable in any
   * client. Any other name is refused rather than created.
   */
  async ensureLabel(name: string): Promise<string> {
    if (name !== SNOOZED_LABEL) throw new GmailError(`Winnow only makes its own ${SNOOZED_LABEL} label.`, 400, "unknown");
    const listing = await this.request<{ labels?: { id: string; name: string }[] }>("/users/me/labels");
    const found = listing.labels?.find((label) => label.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const made = await this.request<{ id: string }>("/users/me/labels", {
      method: "POST",
      body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    return made.id;
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
    if (needsUpload(raw)) {
      return this.request<GmailSendResponse>("/users/me/messages/send?uploadType=multipart", {
        method: "POST",
        upload: uploadBody(threadId ? { threadId } : {}, raw),
      });
    }
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

  async draft(id: string): Promise<GmailFullDraft> {
    return this.request<GmailFullDraft>(`/users/me/drafts/${encodeURIComponent(id)}?format=full`);
  }

  /**
   * Save a new draft. The raw message is base64url-encoded here for the same reason as
   * `send`; `threadId` files a reply's draft on its conversation.
   */
  async createDraft(raw: string, threadId?: string): Promise<GmailDraft> {
    if (needsUpload(raw)) {
      return this.request<GmailDraft>("/users/me/drafts?uploadType=multipart", {
        method: "POST",
        upload: uploadBody({ message: threadId ? { threadId } : {} }, raw),
      });
    }
    return this.request<GmailDraft>("/users/me/drafts", { method: "POST", body: { message: draftMessage(raw, threadId) } });
  }

  /** Replace a draft's content, keeping its id. */
  async updateDraft(id: string, raw: string, threadId?: string): Promise<GmailDraft> {
    if (needsUpload(raw)) {
      return this.request<GmailDraft>(`/users/me/drafts/${encodeURIComponent(id)}?uploadType=multipart`, {
        method: "PUT",
        upload: uploadBody({ id, message: threadId ? { threadId } : {} }, raw),
      });
    }
    return this.request<GmailDraft>(`/users/me/drafts/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: { id, message: draftMessage(raw, threadId) },
    });
  }

  /**
   * Send a draft, with its latest content. Gmail removes the draft as it sends, so
   * nothing is left behind in Drafts.
   */
  async sendDraft(id: string, raw: string, threadId?: string): Promise<GmailSendResponse> {
    if (needsUpload(raw)) {
      return this.request<GmailSendResponse>("/users/me/drafts/send?uploadType=multipart", {
        method: "POST",
        upload: uploadBody({ id, message: threadId ? { threadId } : {} }, raw),
      });
    }
    return this.request<GmailSendResponse>("/users/me/drafts/send", {
      method: "POST",
      body: { id, message: draftMessage(raw, threadId) },
    });
  }

  /** Delete a draft for good (`drafts.delete` does not go through Trash). */
  async deleteDraft(id: string): Promise<void> {
    await this.request(`/users/me/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async listDrafts(maxResults: number, pageToken?: string): Promise<GmailDraftList> {
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (pageToken) params.set("pageToken", pageToken);
    return this.request<GmailDraftList>(`/users/me/drafts?${params}`);
  }
}

/**
 * Past this many bytes of raw message, a send or draft save goes through the media
 * upload endpoint. The JSON endpoints carry the message base64url-encoded inside the
 * request body, which Gmail caps well under the 25 MB attachments allow (and which grows
 * the payload by a third); the upload endpoint takes the RFC 822 message as it is, up to
 * 35 MB.
 */
export const UPLOAD_THRESHOLD = 4 * 1024 * 1024;

function needsUpload(raw: string): boolean {
  return raw.length > UPLOAD_THRESHOLD;
}

/**
 * A `multipart/related` upload: the JSON metadata (thread, draft id), then the message.
 * The boundary is checked against the message, which is all base64 and headers, so a
 * collision is impossible in practice and refused in principle.
 */
export function uploadBody(metadata: Record<string, unknown>, raw: string): { contentType: string; body: string } {
  let boundary = "winnow_upload_boundary";
  while (raw.includes(boundary)) boundary += "_";
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: message/rfc822",
    "",
    raw,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { contentType: `multipart/related; boundary=${boundary}`, body };
}

/** The `message` half of a draft request. */
function draftMessage(raw: string, threadId?: string): Record<string, unknown> {
  const message: Record<string, unknown> = { raw: base64UrlEncode(new TextEncoder().encode(raw)) };
  if (threadId) message.threadId = threadId;
  return message;
}

/**
 * SENT and DRAFT are set by Gmail itself and cannot be added or removed through
 * `messages.modify`: the API answers 400 "Invalid label: SENT" and applies none of the
 * other changes in the same call. Refused here, before the request, so a caller that
 * lists one fails loudly in tests instead of quietly breaking every archive in prod.
 */
const FIXED_LABELS: readonly string[] = [LABEL.sent, LABEL.draft];

function refuseFixedLabels(labelIds: readonly string[]): void {
  const fixed = labelIds.filter((label) => FIXED_LABELS.includes(label));
  if (fixed.length > 0) {
    throw new GmailError(`Gmail does not allow changing the ${fixed.join(", ")} label.`, 400, "unknown");
  }
}

/**
 * The Gmail API client.
 *
 * A thin, typed wrapper over `fetch` with one interesting behaviour: a 401
 * triggers exactly one forced token refresh and one retry. After that the error
 * propagates, because a second 401 means the refresh token is gone (revoked,
 * password changed, or the scope changed) and retrying would loop against the
 * API for no gain.
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
  type GmailAttachmentResponse,
  type GmailHistoryResponse,
  type GmailListResponse,
  type GmailMessage,
  type GmailProfile,
  type GmailSendResponse,
} from "./dto";

/** Gmail's maximum page size. Asking for more is silently clamped. */
export const MAX_PAGE_SIZE = 200;

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
};

export class GmailClient {
  private readonly fetchImpl: FetchLike;
  private readonly onUnauthorized: (() => Promise<string | null>) | undefined;

  constructor(
    private readonly tokenProvider: TokenProvider,
    options: GmailClientOptions = {},
  ) {
    const globalFetch = globalThis.fetch?.bind(globalThis) as FetchLike | undefined;
    const impl = options.fetchImpl ?? globalFetch;
    if (!impl) throw new Error("no fetch implementation available");
    this.fetchImpl = impl;
    this.onUnauthorized = options.onUnauthorized;
  }

  /**
   * One request, with one transparent retry after a forced refresh.
   *
   * `allowRetry` is threaded rather than looped so the retry cannot itself
   * recurse: a refresh that returns another 401 has to surface, not spin.
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
    const send = async (bearer: string) => {
      const response = await this.fetchImpl(url, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await response.text();
      return { response, text };
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
      return JSON.parse(retry.text) as T;
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

  /** Changes since `startHistoryId`. */
  async history(startHistoryId: string, pageToken?: string): Promise<GmailHistoryResponse> {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded",
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

  /** Send a raw RFC 822 message. See `mime.ts` for the body. */
  async send(raw: string, threadId?: string): Promise<GmailSendResponse> {
    const body: Record<string, unknown> = { raw };
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

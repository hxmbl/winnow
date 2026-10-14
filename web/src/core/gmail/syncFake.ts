/**
 * A fake Gmail with latency, for the sync engine's concurrency tests and benchmark.
 *
 * Not imported by the app. It lives beside the engine (rather than inside one test
 * file) because two suites share it: `sync.parallel.test.ts` checks behaviour and
 * `sync.bench.test.ts` measures old-vs-new on a 1,000-message inbox.
 *
 * Every request waits `latencyMs` on `setTimeout` — so a suite on fake timers measures
 * simulated time — and, optionally, takes its quota units from a `QuotaBucket` first,
 * exactly like `GmailClient.request`, so the benchmark can show where quota (not
 * latency) becomes the ceiling.
 */

import { QuotaBucket, costOf, type MessageFormat } from "./client";
import { GmailHttpError, LABEL, type GmailListResponse, type GmailMessage, type GmailProfile } from "./dto";
import type { CursorStore, MailboxCache } from "./sync";
import type { Email } from "../model/email";

export type FakeGmailOptions = {
  messages: GmailMessage[];
  latencyMs?: number;
  /** Charge each request against a quota bucket, as the real client does. */
  bucket?: QuotaBucket;
  /** Ids that fail with a 503 every time. */
  failing?: ReadonlySet<string>;
};

export type FakeCall = { method: string; id?: string; format?: MessageFormat; query?: string; at: number };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function latencyGmail(options: FakeGmailOptions) {
  const byId = new Map(options.messages.map((message) => [message.id, message]));
  const calls: FakeCall[] = [];
  const history: { pages: { history: unknown[]; nextPageToken?: string }[]; historyId: string } = {
    pages: [],
    historyId: "H2",
  };
  let inFlight = 0;
  let peak = 0;

  const request = async <T>(path: string, run: () => T): Promise<T> => {
    if (options.bucket) await options.bucket.take(costOf(path, "GET"));
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      await wait(options.latencyMs ?? 0);
      return run();
    } finally {
      inFlight -= 1;
    }
  };

  const client = {
    profile(): Promise<GmailProfile> {
      calls.push({ method: "profile", at: Date.now() });
      return request("/users/me/profile", () => ({ emailAddress: "me@example.com", historyId: "H1" }));
    },
    list(query: string, maxResults: number, pageToken?: string): Promise<GmailListResponse> {
      calls.push({ method: "list", query, at: Date.now() });
      return request("/users/me/messages", () => {
        const start = pageToken ? Number(pageToken) : 0;
        const matching = options.messages.filter((message) => matches(message, query));
        const slice = matching.slice(start, start + maxResults);
        const next = start + maxResults;
        return {
          messages: slice.map((message) => ({ id: message.id, threadId: message.threadId ?? message.id })),
          nextPageToken: next < matching.length ? String(next) : undefined,
        };
      });
    },
    message(id: string, format: MessageFormat = "full"): Promise<GmailMessage> {
      calls.push({ method: "message", id, format, at: Date.now() });
      return request(`/users/me/messages/${id}?format=${format}`, () => {
        if (options.failing?.has(id)) throw new GmailHttpError(503, "backend error");
        const message = byId.get(id);
        if (!message) throw new GmailHttpError(404, "not found");
        if (format === "full") return message;
        // What `format=metadata` returns: headers and top-level type, no leaves.
        return {
          ...message,
          payload: message.payload
            ? { mimeType: message.payload.mimeType, headers: message.payload.headers }
            : undefined,
        };
      });
    },
    history(_start: string, pageToken?: string) {
      calls.push({ method: "history", at: Date.now() });
      return request("/users/me/history", () => {
        const page = history.pages[pageToken ? Number(pageToken) : 0];
        return { history: page?.history ?? [], nextPageToken: page?.nextPageToken, historyId: history.historyId };
      });
    },
  };

  return {
    client: client as never,
    calls,
    history,
    peak: () => peak,
    remove: (id: string) => byId.delete(id),
  };
}

function matches(message: GmailMessage, query: string): boolean {
  const labels = message.labelIds ?? [];
  if (query === "in:inbox") return labels.includes(LABEL.inbox);
  if (query === "in:sent") return labels.includes(LABEL.sent) && !labels.includes(LABEL.inbox);
  if (query === "in:trash") return labels.includes(LABEL.trash);
  if (query === "in:spam") return labels.includes(LABEL.spam);
  if (query.startsWith("-in:inbox")) {
    return ![LABEL.inbox, LABEL.trash, LABEL.spam, LABEL.sent, LABEL.draft].some((label) => labels.includes(label));
  }
  return false;
}

/** A Gmail message with a plain body, `minutesAgo` minutes before a fixed instant. */
export function fakeMessage(id: string, labels: string[], minutesAgo = 0): GmailMessage {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: labels,
    snippet: `snippet ${id}`,
    sizeEstimate: 2048,
    internalDate: String(Date.UTC(2026, 9, 14, 12, 0) - minutesAgo * 60_000),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: `Sender ${id} <sender-${id}@mail.test>` },
        { name: "Subject", value: `Subject ${id}` },
      ],
      body: { data: btoa(`Body of ${id}`), size: 12 },
    },
  };
}

/** An in-memory cache and a separate cursor store (the two `clear`s must not meet). */
export function memoryStore(seed: Email[] = []) {
  const rows = new Map(seed.map((email) => [email.gmailId, email]));
  let current: string | null = null;
  const cache: MailboxCache = {
    async all() {
      return [...rows.values()].sort((a, b) => b.receivedAt - a.receivedAt);
    },
    async upsert(emails) {
      for (const email of emails) rows.set(email.gmailId, email);
    },
    async remove(ids) {
      for (const id of ids) rows.delete(id);
    },
    async gmailIds() {
      return [...rows.keys()];
    },
    async keepOnly(ids) {
      const keep = new Set(ids);
      for (const id of [...rows.keys()]) if (!keep.has(id)) rows.delete(id);
    },
    async replace(emails) {
      rows.clear();
      for (const email of emails) rows.set(email.gmailId, email);
    },
    async clear() {
      rows.clear();
    },
  };
  const cursor: CursorStore = {
    async read() {
      return current;
    },
    async write(id) {
      current = id;
    },
    async clear() {
      current = null;
    },
  };
  return { cache, cursor, rows, current: () => current, setCursor: (id: string | null) => (current = id) };
}

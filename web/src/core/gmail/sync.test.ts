import { describe, expect, it } from "vitest";
import { GmailSyncEngine, type CursorStore, type MailboxCache } from "./sync";
import {
  GmailHttpError,
  LABEL,
  type GmailListResponse,
  type GmailMessage,
  type GmailProfile,
} from "./dto";
import { toEmail } from "./mapper";
import { hashId } from "../model/ids";
import type { Email } from "../model/email";

/**
 * A fake Gmail.
 *
 * Messages are stored by id, and every call is recorded, so a test can assert
 * *how* the engine talked to the API — not just what it ended up with. The
 * behaviour worth testing in a sync engine is almost all about which requests
 * were made and in what order.
 */
function fakeGmail(options: { messages: GmailMessage[]; historyId?: string } = { messages: [] }) {
  const store = new Map(options.messages.map((m) => [m.id, m]));
  const calls: { method: string; arg: string }[] = [];
  const historyPages: { records: unknown[]; nextPageToken?: string }[] = [];
  const failures = new Map<string, number>();
  let historyExhausted = false;
  let profileHistoryId = options.historyId ?? "H1";

  const client = {
    async profile(): Promise<GmailProfile> {
      calls.push({ method: "profile", arg: "" });
      return { emailAddress: "user@example.com", historyId: profileHistoryId };
    },
    async list(query: string, maxResults: number, pageToken?: string): Promise<GmailListResponse> {
      calls.push({ method: "list", arg: query });
      // Page by the maxResults the engine asked for, so a test can prove it
      // honoured a cap.
      const start = pageToken ? Number(pageToken) : 0;
      const matching = options.messages.filter((m) => matchesQuery(m, query));
      const slice = matching.slice(start, start + maxResults);
      const next = start + maxResults;
      return {
        messages: slice.map((m) => ({ id: m.id, threadId: m.threadId ?? m.id })),
        nextPageToken: next < matching.length ? String(next) : undefined,
      };
    },
    async message(id: string): Promise<GmailMessage> {
      calls.push({ method: "message", arg: id });
      const remainingFailures = failures.get(id) ?? 0;
      if (remainingFailures > 0) {
        failures.set(id, remainingFailures - 1);
        throw new GmailHttpError(503, "transient");
      }
      const message = store.get(id);
      if (!message) throw new GmailHttpError(404, "not found");
      return message;
    },
    async history(startHistoryId: string, pageToken?: string) {
      calls.push({ method: "history", arg: startHistoryId });
      if (historyExhausted) throw new GmailHttpError(404, "history expired");
      const page = historyPages[pageToken ? Number(pageToken) : 0];
      return { history: page?.records ?? [], historyId: pageHistoryId(), nextPageToken: page?.nextPageToken };
    },
  };

  function pageHistoryId(): string {
    // The cursor advances to the last page seen.
    return `H${historyPages.length + 1}`;
  }

  return {
    client: client as never,
    calls,
    failTimes: (id: string, times: number) => failures.set(id, times),
    setHistory: (pages: { records: unknown[]; nextPageToken?: string }[]) => {
      historyPages.length = 0;
      historyPages.push(...pages);
    },
    expireHistory: () => {
      historyExhausted = true;
    },
    setProfileHistoryId: (id: string) => {
      profileHistoryId = id;
    },
  };
}

/** A crude query matcher, matching the four views the engine uses. */
function matchesQuery(message: GmailMessage, query: string): boolean {
  const labels = message.labelIds ?? [];
  if (query === "in:inbox") return labels.includes(LABEL.inbox);
  if (query === "in:trash") return labels.includes(LABEL.trash);
  if (query === "in:spam") return labels.includes(LABEL.spam);
  if (query.startsWith("-in:inbox")) {
    return !labels.includes(LABEL.inbox) && !labels.includes(LABEL.trash);
  }
  return true;
}

function gmailMessage(id: string, labels: string[], extra: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: labels,
    snippet: `snippet ${id}`,
    internalDate: String(Date.UTC(2026, 4, 9, 12, 0)),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: `Sender ${id} <sender-${id}@example.com>` },
        { name: "Subject", value: `Subject ${id}` },
      ],
      body: { data: btoa(`Body of ${id}`), size: 100 },
    },
    ...extra,
  };
}

/** An in-memory cache, so the engine's own bookkeeping is what is under test. */
function memoryCache(seed: Email[] = []) {
  let emails = [...seed];
  const cursors: string[] = [];
  const cache: MailboxCache & CursorStore = {
    async all() {
      return [...emails].sort((a, b) => b.receivedAt - a.receivedAt);
    },
    async upsert(incoming) {
      const byId = new Map(emails.map((e) => [e.gmailId, e]));
      for (const email of incoming) byId.set(email.gmailId, email);
      emails = [...byId.values()];
    },
    async remove(gmailIds) {
      const drop = new Set(gmailIds);
      emails = emails.filter((e) => !drop.has(e.gmailId));
    },
    async gmailIds() {
      return emails.map((e) => e.gmailId);
    },
    async keepOnly(gmailIds) {
      const keep = new Set(gmailIds);
      emails = emails.filter((e) => keep.has(e.gmailId));
    },
    async replace(next) {
      emails = [...next];
    },
    async clear() {
      emails = [];
    },
    async read() {
      return cursors[0] ?? null;
    },
    async write(historyId) {
      cursors.push(historyId);
    },
    async clear_cursor() {},
  } as MailboxCache & CursorStore;
  // `clear()` above wipes messages; the cursor needs its own method.
  const withCursor: MailboxCache & CursorStore = Object.assign(cache, {
    async clearCursor() {
      cursors.length = 0;
    },
  });
  return { cache: withCursor, peek: () => emails, cursors };
}

describe("full sync", () => {
  it("fetches every view and files messages by label", async () => {
    const gmail = fakeGmail({
      messages: [
        gmailMessage("a", [LABEL.inbox]),
        gmailMessage("b", [LABEL.inbox, LABEL.trash]),
        gmailMessage("c", [LABEL.spam]),
        gmailMessage("d", []),
      ],
    });
    const { cache, peek } = memoryCache();
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache,
      cursor: { read: async () => null, write: async () => {}, clear: async () => {} },
    });

    const result = await engine.full();

    expect(result.failed).toBe(0);
    const byId = new Map(peek().map((e) => [e.gmailId, e.mailbox]));
    // Trash beats inbox: a message mid-move can carry both, and "where can the
    // user get rid of it" is the better question.
    expect(byId.get("a")).toBe("inbox");
    expect(byId.get("b")).toBe("trash");
    expect(byId.get("c")).toBe("spam");
    expect(byId.get("d")).toBe("archive");
  });

  it("drops mail the user wrote", async () => {
    // Sent and drafts are not a tracked view. Leaving them in put a copy of
    // every reply in the inbox.
    const gmail = fakeGmail({ messages: [gmailMessage("s", [LABEL.sent])] });
    const { cache, peek } = memoryCache();
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache,
      cursor: { read: async () => null, write: async () => {}, clear: async () => {} },
    });
    await engine.full();
    expect(peek().map((e) => e.gmailId)).not.toContain("s");
  });

  it("deletes cached messages that no longer exist anywhere", async () => {
    // A message that vanished server-side was deleted. Keeping it would leave a
    // ghost in the inbox forever.
    const stale = toEmail(gmailMessage("gone", [LABEL.inbox]))!;
    const { cache, peek } = memoryCache([stale]);
    const gmail = fakeGmail({ messages: [gmailMessage("fresh", [LABEL.inbox])] });
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache,
      cursor: { read: async () => null, write: async () => {}, clear: async () => {} },
    });

    await engine.full();
    expect(peek().map((e) => e.gmailId).sort()).toEqual(["fresh"]);
  });

  it("does not advance the cursor when a message failed to download", async () => {
    // Advancing past a failure means that message is skipped on the next sync
    // and never arrives at all.
    const gmail = fakeGmail({ messages: [gmailMessage("a", [LABEL.inbox])] });
    gmail.failTimes("a", 1);
    const { cache, cursors } = memoryCache();
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache,
      cursor: {
        read: async () => null,
        write: async (id: string) => {
          cursors.push(id);
        },
        clear: async () => {},
      },
    });

    const result = await engine.full();
    expect(result.failed).toBe(1);
    expect(cursors).toHaveLength(0);
  });

  it("keeps the cached copy of a message that failed to download", async () => {
    // Treating a network blip as a deletion loses mail the user can still read.
    const existing = toEmail(gmailMessage("a", [LABEL.inbox]))!;
    const { cache, peek } = memoryCache([existing]);
    const gmail = fakeGmail({ messages: [gmailMessage("a", [LABEL.inbox])] });
    gmail.failTimes("a", 5);
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache,
      cursor: { read: async () => null, write: async () => {}, clear: async () => {} },
    });

    await engine.full();
    expect(peek().map((e) => e.gmailId)).toContain("a");
  });

  it("takes the cursor from the profile *before* paging", async () => {
    // Taken after, anything that arrived mid-sync would be skipped.
    const gmail = fakeGmail({ messages: [gmailMessage("a", [LABEL.inbox])] });
    gmail.setProfileHistoryId("H-start");
    const seen: string[] = [];
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache: memoryCache().cache,
      cursor: {
        read: async () => null,
        write: async (id: string) => {
          seen.push(id);
        },
        clear: async () => {},
      },
    });

    await engine.full();
    expect(seen).toEqual(["H-start"]);
    // And the profile call came first.
    expect(gmail.calls[0].method).toBe("profile");
  });

  it("fetches each message once even when views overlap", async () => {
    const gmail = fakeGmail({
      messages: [gmailMessage("a", [LABEL.inbox]), gmailMessage("a", [LABEL.inbox])],
    });
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache: memoryCache().cache,
      cursor: { read: async () => null, write: async () => {}, clear: async () => {} },
    });
    await engine.full();
    const fetches = gmail.calls.filter((c) => c.method === "message");
    expect(fetches).toHaveLength(1);
  });
});

describe("incremental sync", () => {
  it("does nothing without a cursor, and does a full sync instead", async () => {
    const gmail = fakeGmail({ messages: [gmailMessage("a", [LABEL.inbox])] });
    const { cache, peek } = memoryCache();
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache,
      cursor: { read: async () => null, write: async () => {}, clear: async () => {} },
    });

    await engine.incremental();
    expect(peek()).toHaveLength(1);
    expect(gmail.calls.some((c) => c.method === "history")).toBe(false);
  });

  it("re-fetches a touched message whole rather than applying the label diff", async () => {
    // Reconstructing state from a diff means trusting every label change was
    // reported and applied. One missed event leaves a message in the wrong
    // mailbox forever; re-fetching cannot drift.
    const message = gmailMessage("a", [LABEL.inbox]);
    const gmail = fakeGmail({ messages: [message] });
    gmail.setHistory([
      { records: [{ id: "1", labelsAdded: [{ message: { id: "a" }, labelIds: [LABEL.inbox] }] }] },
    ]);

    const { cache, peek } = memoryCache();
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache,
      cursor: { read: async () => "H0", write: async () => {}, clear: async () => {} },
    });

    await engine.incremental();
    expect(gmail.calls.some((c) => c.method === "message" && c.arg === "a")).toBe(true);
    expect(peek().map((e) => e.gmailId)).toEqual(["a"]);
  });

  it("removes a message that history says was deleted", async () => {
    const stale = toEmail(gmailMessage("gone", [LABEL.inbox]))!;
    const { cache, peek } = memoryCache([stale]);
    const gmail = fakeGmail({ messages: [] });
    gmail.setHistory([{ records: [{ id: "1", messagesDeleted: [{ id: "gone" }] }] }]);

    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache,
      cursor: { read: async () => "H0", write: async () => {}, clear: async () => {} },
    });

    await engine.incremental();
    expect(peek().map((e) => e.gmailId)).not.toContain("gone");
  });

  it("falls back to a full rebuild when the cursor has expired", async () => {
    // Gmail only retains history for a limited window. Past it the cursor is
    // invalid, not stale, and carrying on would silently skip everything since.
    const gmail = fakeGmail({ messages: [gmailMessage("a", [LABEL.inbox])] });
    gmail.expireHistory();
    const { cache, peek } = memoryCache();
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache,
      cursor: { read: async () => "ancient", write: async () => {}, clear: async () => {} },
    });

    await engine.incremental();
    expect(peek().map((e) => e.gmailId)).toEqual(["a"]);
    // A full rebuild actually happened, rather than the 404 being swallowed.
    expect(gmail.calls.some((c) => c.method === "list")).toBe(true);
  });

  it("advances the cursor to the last page", async () => {
    const gmail = fakeGmail({ messages: [] });
    gmail.setHistory([{ records: [] }, { records: [] }]);
    const written: string[] = [];
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache: memoryCache().cache,
      cursor: { read: async () => "H0", write: async (id) => {
          written.push(id);
        }, clear: async () => {} },
    });

    await engine.incremental();
    expect(written).toHaveLength(1);
    expect(written[0]).not.toBe("H0");
  });

  it("does not advance the cursor when a touched message failed", async () => {
    const gmail = fakeGmail({ messages: [gmailMessage("a", [LABEL.inbox])] });
    gmail.failTimes("a", 3);
    gmail.setHistory([{ records: [{ id: "1", messagesAdded: [{ message: { id: "a" } }] }] }]);
    const written: string[] = [];
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache: memoryCache().cache,
      cursor: { read: async () => "H0", write: async (id) => {
          written.push(id);
        }, clear: async () => {} },
    });

    const result = await engine.incremental();
    expect(result.failed).toBeGreaterThan(0);
    expect(written).toHaveLength(0);
  });
});

describe("sync — choosing a strategy", () => {
  it("goes incremental when a cursor exists and full when it does not", async () => {
    const gmail = fakeGmail({ messages: [gmailMessage("a", [LABEL.inbox])] });
    let cursor: string | null = "H0";
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache: memoryCache().cache,
      cursor: {
        read: async () => cursor,
        write: async (id) => {
          cursor = id;
        },
        clear: async () => {
          cursor = null;
        },
      },
    });

    await engine.sync();
    expect(gmail.calls.some((c) => c.method === "history")).toBe(true);
    expect(gmail.calls.some((c) => c.method === "list")).toBe(false);

    // A rebuild forces the other path.
    const before = gmail.calls.length;
    await engine.rebuild();
    expect(gmail.calls.slice(before).some((c) => c.method === "list")).toBe(true);
  });
});

describe("sync — progress reporting", () => {
  it("reports the phase and a running count", async () => {
    const gmail = fakeGmail({
      messages: [gmailMessage("a", [LABEL.inbox]), gmailMessage("b", [LABEL.inbox])],
    });
    const progress: { phase: string; fetched: number }[] = [];
    const engine = new GmailSyncEngine({
      client: gmail.client,
      cache: memoryCache().cache,
      cursor: { read: async () => null, write: async () => {}, clear: async () => {} },
      onProgress: (p) => progress.push({ phase: p.phase, fetched: p.fetched }),
    });

    await engine.full();
    expect(progress[0].phase).toBe("full");
    // Ends idle, so a UI can clear its spinner on the last event rather than
    // having to know when the promise settles.
    expect(progress[progress.length - 1].phase).toBe("idle");
    expect(progress[progress.length - 1].fetched).toBe(2);
  });
});

describe("the mapper and the engine agree on the id", () => {
  it("keys the cache on the Gmail id, not the derived number", () => {
    // The number is a UI handle; the string is the authority. If they could
    // disagree, a cached classification would attach to the wrong message.
    const message = gmailMessage("stable-id", [LABEL.inbox]);
    const email = toEmail(message)!;
    expect(email.gmailId).toBe("stable-id");
    expect(email.id).toBe(hashId("stable-id"));
  });
});

/**
 * The sync engine's fast path: pooled metadata fetches, inbox-first publishing,
 * history de-duplication, and bodies that survive a re-fetch.
 */

import { describe, expect, it } from "vitest";
import { FETCH_CONCURRENCY, FIRST_PAINT, GmailSyncEngine } from "./sync";
import { LABEL } from "./dto";
import { toEmail } from "./mapper";
import { fakeMessage, latencyGmail, memoryStore } from "./syncFake";
import type { Email } from "../model/email";

function inbox(count: number, prefix = "i") {
  return Array.from({ length: count }, (_, i) => fakeMessage(`${prefix}${i}`, [LABEL.inbox], i));
}

function engineFor(gmail: ReturnType<typeof latencyGmail>, store = memoryStore()) {
  return { engine: new GmailSyncEngine({ client: gmail.client, cache: store.cache, cursor: store.cursor }), store };
}

describe("full sync — pooled metadata fetches", () => {
  it("fetches metadata only, with at most FETCH_CONCURRENCY requests in flight", async () => {
    const gmail = latencyGmail({ messages: inbox(60), latencyMs: 2 });
    const { engine, store } = engineFor(gmail);
    const result = await engine.full();

    const fetches = gmail.calls.filter((call) => call.method === "message");
    expect(fetches).toHaveLength(60);
    expect(fetches.every((call) => call.format === "metadata")).toBe(true);
    expect(gmail.peak()).toBe(FETCH_CONCURRENCY);
    expect(result.emails).toHaveLength(60);
    // Every row says its body is a stand-in, so the store knows to load it on open.
    expect(result.emails.every((email) => email.bodyLoaded === false)).toBe(true);
    expect(result.emails[0].body).toMatch(/^snippet /);
    expect(store.current()).toBe("H1");
  });

  it("requests the newest inbox mail first", async () => {
    const gmail = latencyGmail({ messages: inbox(30), latencyMs: 1 });
    await engineFor(gmail).engine.full();
    const order = gmail.calls.filter((call) => call.method === "message").map((call) => call.id);
    expect(order.slice(0, 8)).toEqual(["i0", "i1", "i2", "i3", "i4", "i5", "i6", "i7"]);
  });

  it("keeps failure accounting intact under concurrency: failed is counted, cached copy kept, cursor held", async () => {
    const messages = inbox(20);
    const cachedCopy = { ...toEmail(messages[5])!, mailbox: "inbox" as const };
    const gmail = latencyGmail({ messages, latencyMs: 1, failing: new Set(["i5", "i9"]) });
    const store = memoryStore([cachedCopy]);
    const { engine } = engineFor(gmail, store);

    const result = await engine.full();
    expect(result.failed).toBe(2);
    // i5 failed but was cached, so it stays; i9 failed and was never cached.
    expect(store.rows.has("i5")).toBe(true);
    expect(store.rows.get("i5")!.body).toBe("Body of i5");
    expect(store.current()).toBeNull();
  });

  it("forgets a message the server says is gone (missing is not failed)", async () => {
    const stale: Email = { ...toEmail(fakeMessage("gone", [LABEL.inbox]))!, mailbox: "inbox" };
    const gmail = latencyGmail({ messages: inbox(3), latencyMs: 1 });
    const store = memoryStore([stale]);
    const result = await engineFor(gmail, store).engine.full();
    expect(result.failed).toBe(0);
    expect(store.rows.has("gone")).toBe(false);
  });

  it("keeps a body the cache already had when it re-fetches metadata", async () => {
    const messages = inbox(3);
    const loaded: Email = { ...toEmail(messages[1])!, mailbox: "inbox" };
    const gmail = latencyGmail({ messages, latencyMs: 1 });
    const store = memoryStore([loaded]);
    await engineFor(gmail, store).engine.full();

    expect(store.rows.get("i1")!.bodyLoaded).toBe(true);
    expect(store.rows.get("i1")!.body).toBe("Body of i1");
    expect(store.rows.get("i0")!.bodyLoaded).toBe(false);
  });
});

describe("full sync — inbox first", () => {
  it("publishes the inbox once it has a screenful, before any other view is fetched", async () => {
    const messages = [
      ...inbox(80),
      ...Array.from({ length: 30 }, (_, i) => fakeMessage(`s${i}`, [LABEL.sent], i)),
      ...Array.from({ length: 30 }, (_, i) => fakeMessage(`a${i}`, [], i)),
    ];
    const gmail = latencyGmail({ messages, latencyMs: 1 });
    const { engine } = engineFor(gmail);
    const partials: { size: number; mailboxes: Set<string>; fetchedSoFar: number }[] = [];

    await engine.full(undefined, (emails) => {
      partials.push({
        size: emails.length,
        mailboxes: new Set(emails.map((email) => email.mailbox)),
        fetchedSoFar: gmail.calls.filter((call) => call.method === "message").length,
      });
    });

    expect(partials.length).toBeGreaterThanOrEqual(2);
    const first = partials[0];
    expect(first.size).toBeGreaterThanOrEqual(FIRST_PAINT);
    expect(first.size).toBeLessThan(80);
    expect([...first.mailboxes]).toEqual(["inbox"]);

    // Every inbox fetch went out before the first fetch for another view.
    const fetchIds = gmail.calls.filter((call) => call.method === "message").map((call) => call.id!);
    const lastInbox = Math.max(...fetchIds.map((id, i) => (id.startsWith("i") ? i : -1)));
    const firstOther = fetchIds.findIndex((id) => !id.startsWith("i"));
    expect(lastInbox).toBeLessThan(firstOther);

    // And the whole inbox was published before the background views started.
    const inboxDone = partials.find((partial) => partial.size === 80);
    expect(inboxDone).toBeDefined();
    expect([...inboxDone!.mailboxes]).toEqual(["inbox"]);
  });

  it("reports the stage and a known total", async () => {
    const gmail = latencyGmail({
      messages: [...inbox(10), fakeMessage("s0", [LABEL.sent])],
      latencyMs: 1,
    });
    const stages: string[] = [];
    let lastTotal = 0;
    await engineFor(gmail).engine.full((progress) => {
      if (progress.stage) stages.push(progress.stage);
      if (progress.total) lastTotal = progress.total;
    });
    expect(stages[0]).toBe("inbox");
    expect(stages).toContain("other");
    expect(lastTotal).toBe(11);
  });
});

describe("incremental sync — batched history", () => {
  it("fetches a message touched by several records, across pages, once", async () => {
    const messages = inbox(5);
    const gmail = latencyGmail({ messages, latencyMs: 1 });
    const store = memoryStore();
    store.setCursor("H1");
    gmail.history.pages = [
      {
        history: [
          { id: "1", labelsAdded: [{ message: { id: "i1" }, labelIds: [LABEL.starred] }] },
          { id: "2", labelsRemoved: [{ message: { id: "i1" }, labelIds: [LABEL.unread] }] },
          { id: "3", messagesAdded: [{ message: { id: "i2" } }] },
        ],
        nextPageToken: "1",
      },
      {
        history: [
          { id: "4", labelsAdded: [{ message: { id: "i1" }, labelIds: [LABEL.inbox] }] },
          { id: "5", messagesAdded: [{ message: { id: "i3" } }] },
          { id: "6", messagesDeleted: [{ id: "i3" }] },
        ],
      },
    ];
    const { engine } = engineFor(gmail, store);
    const result = await engine.incremental();

    const fetched = gmail.calls.filter((call) => call.method === "message").map((call) => call.id).sort();
    // i1 once despite three records; i3 not at all, because it was deleted.
    expect(fetched).toEqual(["i1", "i2"]);
    expect(result.failed).toBe(0);
    expect(store.current()).toBe("H2");
    expect(gmail.calls.every((call) => call.method !== "message" || call.format === "metadata")).toBe(true);
  });

  it("keeps a loaded body when a label change re-fetches the message", async () => {
    const messages = inbox(2);
    const loaded: Email = { ...toEmail(messages[0])!, mailbox: "inbox" };
    const gmail = latencyGmail({ messages, latencyMs: 1 });
    const store = memoryStore([loaded]);
    store.setCursor("H1");
    gmail.history.pages = [{ history: [{ id: "1", labelsAdded: [{ message: { id: "i0" }, labelIds: [LABEL.starred] }] }] }];
    await engineFor(gmail, store).engine.incremental();
    expect(store.rows.get("i0")!.body).toBe("Body of i0");
    expect(store.rows.get("i0")!.bodyLoaded).toBe(true);
  });

  it("holds the cursor when a touched message fails, and removes one that is missing", async () => {
    const messages = inbox(3);
    const gmail = latencyGmail({ messages, latencyMs: 1, failing: new Set(["i1"]) });
    const store = memoryStore([{ ...toEmail(fakeMessage("ghost", [LABEL.inbox]))!, mailbox: "inbox" }]);
    store.setCursor("H1");
    gmail.history.pages = [
      { history: [{ id: "1", messagesAdded: [{ message: { id: "i1" } }, { message: { id: "ghost" } }] }] },
    ];
    const result = await engineFor(gmail, store).engine.incremental();
    expect(result.failed).toBe(1);
    expect(store.rows.has("ghost")).toBe(false);
    expect(store.current()).toBe("H1");
  });
});

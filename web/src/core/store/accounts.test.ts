/**
 * The store's half of multi-account (1.4.0): entering an account replaces the screen
 * and the per-account learning without erasing anything; a notification's message opens
 * in the reader, fetched first when it is not cached; the From picker's defaults; and the
 * light sync of an account that is not open.
 */

import { describe, expect, it } from "vitest";
import { WinnowStore, type MailBackend } from "./store";
import { LearningModel } from "../learn/learning";
import { defaultFromAccount, draftFromAnotherAccount } from "../mail/fromAccount";
import { LightSync } from "../session/lightSync";
import type { Draft, Email } from "../model/email";
import { hashId } from "../model/ids";
import type { GmailClient } from "../gmail/client";

function email(gmailId: string, fields: Partial<Email> = {}): Email {
  return {
    id: hashId(gmailId),
    gmailId,
    threadId: `t-${gmailId}`,
    sender: "ada@example.com",
    subject: `subject ${gmailId}`,
    body: "words",
    receivedAt: 1_000,
    unread: true,
    mailbox: "inbox",
    attachments: [],
    category: "primary",
    starred: false,
    urgent: false,
    ...fields,
  } as Email;
}

function backend(fetched: Record<string, Email> = {}): MailBackend & { fetches: string[] } {
  const fetches: string[] = [];
  return {
    fetches,
    sync: async () => ({ emails: [email("cached1")], failed: 0, truncated: false }),
    toggleStar: async () => {},
    moveToMailbox: async () => {},
    setRead: async () => {},
    deletePermanently: async () => {},
    sendReply: async () => {},
    fetchAttachment: async () => ({ bytes: new Uint8Array(), filename: "x", mimeType: "x" }),
    fetchBody: async () => undefined,
    fetchMessage: async (gmailId) => {
      fetches.push(gmailId);
      return fetched[gmailId] ?? null;
    },
  };
}

describe("entering an account", () => {
  it("shows the next account's cached mail and its own learning, and persists nothing on the way", () => {
    const writes: unknown[] = [];
    const store = new WinnowStore({ seed: [email("demo1")] });
    store.attach({ onPersist: (patch) => writes.push(patch) });
    const learning = LearningModel.initial().toSnapshot();
    store.enterAccount("acct2xx", { learning, activeFilters: ["urgent"], mailbox: "archive" }, [email("b1")]);
    const snap = store.getSnapshot();
    expect(snap.accountId).toBe("acct2xx");
    expect(snap.all.map((m) => m.gmailId)).toEqual(["b1"]);
    expect(snap.mailbox).toBe("archive");
    expect(snap.activeFilters).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it("a late sync of the old account cannot paint into the next one", async () => {
    let release: (value: { emails: Email[]; failed: number; truncated: boolean }) => void = () => {};
    const slow: MailBackend = { ...backend(), sync: () => new Promise((resolve) => (release = resolve)) };
    const store = new WinnowStore();
    store.enterAccount("acct1xx", {}, []);
    const connecting = store.connect(slow, { email: "a@x.example" }).catch(() => undefined);
    store.enterAccount("acct2xx", {}, [email("b1")]);
    release({ emails: [email("a-late")], failed: 0, truncated: false });
    await connecting;
    expect(store.getSnapshot().all.map((m) => m.gmailId)).not.toContain("a-late");
  });
});

describe("opening a notification's message", () => {
  it("opens the cached copy in the reader", async () => {
    const store = new WinnowStore();
    await store.connect(backend(), { email: "a@x.example" });
    expect(await store.openMessage("cached1")).toBe(true);
    expect(store.getSnapshot().selectedId).toBe(hashId("cached1"));
    expect(store.getSnapshot().mailbox).toBe("inbox");
  });

  it("fetches a message the cache does not have yet, then opens it", async () => {
    const store = new WinnowStore();
    const b = backend({ fresh9: email("fresh9", { subject: "Arrived just now" }) });
    await store.connect(b, { email: "a@x.example" });
    expect(await store.openMessage("fresh9", hashId("fresh9"))).toBe(true);
    expect(b.fetches).toEqual(["fresh9"]);
    expect(store.getSnapshot().selectedId).toBe(hashId("fresh9"));
    expect(store.getSnapshot().all.some((m) => m.subject === "Arrived just now")).toBe(true);
    // A second tap reads the copy now held.
    await store.openMessage("fresh9");
    expect(b.fetches).toEqual(["fresh9"]);
  });

  it("says no for a message Gmail no longer has", async () => {
    const store = new WinnowStore();
    await store.connect(backend(), { email: "a@x.example" });
    expect(await store.openMessage("gone1")).toBe(false);
    expect(store.getSnapshot().selectedId).toBeNull();
  });

  it("a summary opens the inbox, unfiltered, with nothing open", async () => {
    const store = new WinnowStore();
    await store.connect(backend(), { email: "a@x.example" });
    store.setMailbox("archive");
    store.openInbox();
    expect(store.getSnapshot()).toMatchObject({ mailbox: "inbox", selectedId: null, searchQuery: "" });
  });
});

describe("the From address", () => {
  it("a reply starts on the account that received the message, a new message on the open one", () => {
    expect(defaultFromAccount({ mode: "reply", receivedIn: "acct2xx", open: "acct1xx" })).toBe("acct2xx");
    expect(defaultFromAccount({ mode: "forward", receivedIn: "acct2xx", open: "acct1xx" })).toBe("acct2xx");
    expect(defaultFromAccount({ mode: "new", receivedIn: "acct2xx", open: "acct1xx" })).toBe("acct1xx");
    expect(defaultFromAccount({ mode: "reply", receivedIn: null, open: "acct1xx" })).toBe("acct1xx");
  });

  it("a reply from another account keeps threading by headers, not by this mailbox's thread id", () => {
    const draft: Draft = { to: ["ada@example.com"], cc: [], bcc: [], subject: "Re: plan", body: "yes", inReplyTo: "g1", threadId: "t1" };
    const routed = draftFromAnotherAccount(draft, { messageId: "<orig@mail.example>" });
    expect(routed.inReplyTo).toBeUndefined();
    expect(routed.threadId).toBeUndefined();
    expect(routed.replyHeaders).toEqual({ inReplyTo: "<orig@mail.example>", references: "<orig@mail.example>" });
    expect(draft.threadId).toBe("t1");
  });
});

describe("the light sync of an account that is not open", () => {
  function memory() {
    const map = new Map<string, string>();
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
  }
  function client(unread: string[]) {
    const reads: string[] = [];
    const c = {
      list: async () => ({ messages: unread.map((id) => ({ id, threadId: id })), resultSizeEstimate: unread.length }),
      message: async (id: string) => {
        reads.push(id);
        return {
          id,
          threadId: id,
          labelIds: ["INBOX", "UNREAD"],
          internalDate: "5000",
          payload: { mimeType: "text/plain", headers: [{ name: "From", value: "Bob <bob@x.example>" }, { name: "Subject", value: `hello ${id}` }] },
        };
      },
    } as unknown as Pick<GmailClient, "list" | "message">;
    return { c, reads };
  }

  it("counts unread, notifies nothing already waiting, then only what is new", async () => {
    const storage = memory();
    const first = client(["a", "b"]);
    const light = new LightSync(first.c, storage);
    expect(await light.check()).toEqual({ unread: 2, fresh: [] });
    expect(first.reads).toEqual([]);
    const second = client(["c", "a", "b"]);
    const result = await new LightSync(second.c, storage).check();
    expect(result.unread).toBe(3);
    expect(result.fresh.map((m) => m.gmailId)).toEqual(["c"]);
    expect(second.reads).toEqual(["c"]);
  });

  it("mail that was unread when the account was left is not news", async () => {
    const storage = memory();
    const light = new LightSync(client(["a"]).c, storage);
    light.seed(["a", "b"]);
    expect((await new LightSync(client(["a", "b"]).c, storage).check()).fresh).toEqual([]);
  });
});

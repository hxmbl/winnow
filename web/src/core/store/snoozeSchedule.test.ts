/**
 * Snooze and send later, from the store's side (1.4.0): snoozing takes a conversation out
 * of the Inbox with Undo, the Snoozed view lists it with its wake time, waking puts it
 * back unread at the top by its wake time, and the records are kept per account in
 * `winnow.snooze.v1` / `winnow.scheduledSend.v1`. Scheduled sends are listed in their
 * own view and kept out of Drafts.
 */

import { describe, expect, it } from "vitest";
import { WinnowStore, type MailBackend } from "./store";
import { memoryBacking } from "./keyedStorage";
import type { Email, Mailbox } from "../model/email";
import type { ScheduledSend } from "../mail/scheduledSend";

const T = 1_900_000_000_000;
const HOUR = 3_600_000;

function mail(id: number, mailbox: Mailbox, extra: Partial<Email> = {}): Email {
  return {
    id,
    gmailId: `g-${id}`,
    sender: `s${id}@example.com`,
    mailbox,
    receivedAt: T - 10 * HOUR + id,
    subject: `Message ${id}`,
    body: "words",
    category: "primary",
    starred: false,
    unread: false,
    urgent: false,
    attachments: [],
    ...extra,
  };
}

const seed = () => [
  mail(1, "inbox", { threadId: "t-1" }),
  mail(2, "inbox", { threadId: "t-1" }),
  mail(3, "inbox"),
  mail(4, "inbox"),
  mail(5, "archive"),
];

function demo(backing = memoryBacking()) {
  const store = new WinnowStore({ seed: seed(), storage: () => backing, now: T });
  let clock = T;
  store.now = () => clock;
  return { store, backing, tick: (ms: number) => (clock += ms), at: () => clock };
}

const where = (store: WinnowStore, id: number) => store.getSnapshot().all.find((email) => email.id === id);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function liveBackend(emails: Email[], { failSnooze = false } = {}) {
  const calls: string[] = [];
  const backend: MailBackend = {
    async sync() {
      return { emails: emails.map((email) => ({ ...email })), failed: 0, truncated: false };
    },
    async toggleStar() {},
    async moveToMailbox(id, mailbox) {
      calls.push(`move ${id} ${mailbox}`);
    },
    async setRead(id, read) {
      calls.push(`read ${id} ${read}`);
    },
    async deletePermanently() {},
    async sendReply() {},
    async fetchBody() {
      return undefined;
    },
    async fetchAttachment() {
      return { bytes: new Uint8Array(), filename: "a", mimeType: "x" };
    },
    async setSnoozed(gmailId, snoozed, options) {
      calls.push(`snooze ${gmailId} ${snoozed}${options?.unread ? " unread" : ""}${options?.toInbox === false ? " stay" : ""}`);
      if (failSnooze) throw new Error("offline");
    },
  };
  return { backend, calls };
}

async function live(emails: Email[], options?: { failSnooze?: boolean }, backing = memoryBacking()) {
  const fake = liveBackend(emails, options);
  const store = new WinnowStore({ backend: fake.backend, storage: () => backing });
  let clock = T;
  store.now = () => clock;
  await store.connect(fake.backend, { email: "me@example.com" });
  return { store, calls: fake.calls, backing, tick: (ms: number) => (clock += ms) };
}

describe("snoozing", () => {
  it("takes the whole conversation out of the Inbox, lists it in Snoozed with its wake time, and keeps it", () => {
    const { store, backing } = demo();
    expect(store.snooze([2], T + 3 * HOUR)).toBe(1);
    expect(where(store, 1)?.mailbox).toBe("archive");
    expect(where(store, 2)?.mailbox).toBe("archive");
    expect(store.getSnapshot().undo?.label).toMatch(/^Snoozed until /);
    expect(store.view.threads.map((row) => row.representative.id)).not.toContain(2);

    store.setMailbox("snoozed");
    const rows = store.view.threads;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.messageCount).toBe(2);
    expect(rows[0]!.representative.snoozedUntil).toBe(T + 3 * HOUR);
    // Snoozed mail is not also in the Archive.
    store.setMailbox("archive");
    expect(store.view.emails.map((email) => email.id)).toEqual([5]);

    const stored = JSON.parse(backing.getItem("winnow.snooze.v1")!);
    expect(stored.snoozed).toHaveLength(1);
    expect(stored.snoozed[0]).toMatchObject({ key: "t-1", account: "demo", gmailIds: ["g-1", "g-2"], wakeAt: T + 3 * HOUR });
  });

  it("is taken back by Undo, exactly", () => {
    const { store } = demo();
    store.setRead(1, false);
    store.snooze([1], T + HOUR);
    store.undoLast();
    expect(where(store, 1)).toMatchObject({ mailbox: "inbox", unread: true });
    expect(where(store, 2)?.mailbox).toBe("inbox");
    expect(store.getSnapshot().snoozes.snoozed).toEqual([]);
  });

  it("snoozes several at once, with one Undo, and a new time from Snoozed replaces the old", () => {
    const { store } = demo();
    expect(store.snooze([3, 4], T + HOUR)).toBe(2);
    store.setMailbox("snoozed");
    expect(store.view.threads).toHaveLength(2);
    store.snooze([3], T + 5 * HOUR);
    const record = store.getSnapshot().snoozes.snoozed.find((r) => r.key === "g-3");
    expect(record?.wakeAt).toBe(T + 5 * HOUR);
    expect(record?.from).toBe("inbox");
  });

  it("does not snooze mail that is not in the Inbox or the Archive", () => {
    const { store } = demo();
    store.move(4, "trash");
    expect(store.snooze([4], T + HOUR)).toBe(0);
  });
});

describe("waking", () => {
  it("waits for its time, then comes back to the top of the Inbox, unread and new", () => {
    const { store, tick } = demo();
    store.snooze([3], T + 3 * HOUR);
    tick(HOUR);
    expect(store.wakeDue()).toBe(0);
    tick(2 * HOUR);
    expect(store.wakeDue()).toBe(1);
    expect(where(store, 3)).toMatchObject({ mailbox: "inbox", unread: true, receivedAt: T + 3 * HOUR });
    expect(store.view.threads[0]!.representative.id).toBe(3);
    expect(store.getSnapshot().recentIds.has(3)).toBe(true);
    expect(store.getSnapshot().flash?.text).toBe("A snoozed conversation is back in your Inbox.");
    expect(store.getSnapshot().snoozes.snoozed).toEqual([]);
    // Waking twice does nothing more.
    expect(store.wakeDue()).toBe(0);
  });

  it("wakes on the next open when the app was closed at the time, and says it was late", () => {
    const backing = memoryBacking();
    const first = demo(backing);
    first.store.snooze([3], T + HOUR);
    // A new launch, a day later: the demo seed has the message in the Inbox again.
    const again = new WinnowStore({ seed: seed(), storage: () => backing, now: T + 24 * HOUR });
    again.now = () => T + 24 * HOUR;
    expect(again.getSnapshot().all.find((e) => e.id === 3)?.mailbox).toBe("archive");
    expect(again.wakeDue()).toBe(1);
    expect(again.getSnapshot().all.find((e) => e.id === 3)?.mailbox).toBe("inbox");
    expect(again.getSnapshot().flash?.text).toMatch(/while Winnow was closed/);
  });

  it("wakes a conversation early when someone replies in it", () => {
    const { store, tick } = demo();
    store.snooze([1], T + 48 * HOUR);
    tick(2 * HOUR);
    store.replaceAll([...store.getSnapshot().all, mail(9, "inbox", { threadId: "t-1", receivedAt: T + HOUR })]);
    expect(store.wakeDue()).toBe(1);
    expect(where(store, 1)?.mailbox).toBe("inbox");
  });
});

describe("unsnoozing and moving", () => {
  it("Unsnooze puts it back at the top now, read state kept, with an Undo that snoozes it again", () => {
    const { store, tick } = demo();
    store.snooze([3], T + 9 * HOUR);
    tick(HOUR);
    store.setMailbox("snoozed");
    // In Snoozed, `e` (archive) is Unsnooze.
    store.archiveWithUndo([3]);
    expect(where(store, 3)).toMatchObject({ mailbox: "inbox", unread: false, receivedAt: T + HOUR });
    expect(store.getSnapshot().undo?.label).toBe("Unsnoozed.");
    store.undoLast();
    expect(where(store, 3)?.mailbox).toBe("archive");
    expect(store.getSnapshot().snoozes.snoozed[0]?.wakeAt).toBe(T + 9 * HOUR);
  });

  it("moving snoozed mail anywhere ends the snooze", () => {
    const { store } = demo();
    store.snooze([3], T + HOUR);
    store.move(3, "trash");
    expect(where(store, 3)?.mailbox).toBe("trash");
    expect(store.getSnapshot().snoozes.snoozed).toEqual([]);
  });
});

describe("against Gmail", () => {
  it("labels on snooze, unlabels unread on wake, and a sync that still lists it in the Inbox does not bring it back", async () => {
    const emails = [mail(1, "inbox"), mail(2, "inbox")];
    const { store, calls, tick } = await live(emails);
    store.snooze([1], T + HOUR);
    await flush();
    expect(calls).toEqual(["snooze g-1 true"]);
    await store.refresh();
    expect(where(store, 1)?.mailbox).toBe("archive");
    tick(2 * HOUR);
    await store.refresh();
    await flush();
    expect(calls).toContain("snooze g-1 false unread");
    expect(where(store, 1)).toMatchObject({ mailbox: "inbox", unread: true });
  });

  it("falls back to a plain archive (queued offline) when the label cannot be set", async () => {
    const { store, calls } = await live([mail(1, "inbox")], { failSnooze: true });
    store.snooze([1], T + HOUR);
    await flush();
    await flush();
    expect(calls).toEqual(["snooze g-1 true", "move 1 archive"]);
    expect(where(store, 1)?.mailbox).toBe("archive");
    expect(store.getSnapshot().snoozes.snoozed).toHaveLength(1);
  });

  it("undoes a snooze from the Archive without putting it in the Inbox", async () => {
    const { store, calls } = await live([mail(1, "archive")]);
    store.snooze([1], T + HOUR);
    store.undoLast();
    await flush();
    expect(calls).toEqual(["snooze g-1 true", "snooze g-1 false stay"]);
    expect(where(store, 1)?.mailbox).toBe("archive");
  });

  it("keeps the demo's snoozes and an account's apart, and forgets the account's on sign-out", async () => {
    const backing = memoryBacking();
    const first = demo(backing);
    first.store.snooze([1], T + HOUR);
    const { store } = await live([mail(1, "inbox"), mail(2, "inbox")], undefined, backing);
    // The demo's snooze of g-1 does not hide this account's g-1.
    expect(where(store, 1)?.mailbox).toBe("inbox");
    store.snooze([2], T + HOUR);
    await store.signOut();
    const kept = JSON.parse(backing.getItem("winnow.snooze.v1")!);
    expect(kept.snoozed.map((r: { account: string }) => r.account)).toEqual(["demo"]);
  });
});

describe("scheduled sends", () => {
  const send = (id: string, sendAt: number, extra: Partial<ScheduledSend> = {}): ScheduledSend => ({
    id,
    account: "demo",
    sendAt,
    scheduledAt: T,
    mode: "new",
    context: "new",
    draftId: null,
    draft: { to: ["ana@example.com"], cc: [], bcc: [], subject: `Later ${id}`, body: "Hello" },
    ...extra,
  });

  it("lists them in Scheduled, soonest first, and keeps them", () => {
    const { store, backing } = demo();
    store.scheduleSend(send("b", T + 5 * HOUR));
    store.scheduleSend(send("a", T + HOUR, { context: "reply:g-3", mode: "reply", replyTo: "g-3" }));
    store.setMailbox("scheduled");
    const rows = store.view.threads.map((row) => row.representative);
    expect(rows.map((row) => row.subject)).toEqual(["Later a", "Later b"]);
    expect(rows[0]!.scheduled?.sendAt).toBe(T + HOUR);
    expect(store.scheduledSend(rows[1]!.id)?.id).toBe("b");
    expect(JSON.parse(backing.getItem("winnow.scheduledSend.v1")!).sends).toHaveLength(2);
  });

  it("keeps a scheduled draft out of Drafts until it is cancelled", () => {
    const { store } = demo();
    store.putDraftRow({ ...mail(50, "drafts"), gmailDraft: { id: "d-1" } });
    store.putDraftRow({ ...mail(51, "drafts"), gmailDraft: { id: "d-2" } });
    store.scheduleSend(send("a", T + HOUR, { draftId: "d-1" }));
    store.setMailbox("drafts");
    expect(store.view.emails.map((email) => email.gmailDraft?.id)).toEqual(["d-2"]);
    expect(store.cancelSchedule("a")?.id).toBe("a");
    expect(store.view.emails.map((email) => email.gmailDraft?.id).sort()).toEqual(["d-1", "d-2"]);
  });

  it("is claimed by one window at a time", () => {
    const backing = memoryBacking();
    const a = demo(backing);
    a.store.scheduleSend(send("a", T));
    const b = new WinnowStore({ seed: seed(), storage: () => backing, now: T });
    expect(a.store.claimScheduled("a", T)).toBe(true);
    expect(b.claimScheduled("a", T + 1000)).toBe(false);
    expect(b.claimScheduled("a", T + 10 * 60_000)).toBe(true);
  });

  it("shows only this account's", async () => {
    const backing = memoryBacking();
    demo(backing).store.scheduleSend(send("demo-one", T));
    const { store } = await live([mail(1, "inbox")], undefined, backing);
    expect(store.scheduledSends()).toEqual([]);
    store.setMailbox("scheduled");
    expect(store.view.threads).toEqual([]);
  });

  it("forgets one account's snoozes and sends, and leaves every other's", async () => {
    const backing = memoryBacking();
    const { store } = await live([mail(1, "inbox"), mail(2, "inbox")], undefined, backing);
    store.scheduleSend(send("mine", T, { account: "me@example.com" }));
    store.scheduleSend(send("bob", T, { account: "bob@two.example", context: "c-bob" }));
    store.scheduleSend(send("via-bob", T, { account: "me@example.com", context: "c-via", from: "bbbb2222" }));
    store.scheduleSend(send("demo", T, { context: "c-demo" }));
    store.snooze([2], T + HOUR);
    backing.setItem(
      "winnow.snooze.v1",
      JSON.stringify({
        ...JSON.parse(backing.getItem("winnow.snooze.v1")!),
        woke: [{ gmailId: "g-7", account: "bob@two.example", wokeAt: T }],
      }),
    );
    const reread = new WinnowStore({ backend: liveBackend([]).backend, storage: () => backing });
    reread.forgetAccountRecords("Bob@two.example", "bbbb2222");
    const sends = JSON.parse(backing.getItem("winnow.scheduledSend.v1")!).sends.map((r: ScheduledSend) => r.id);
    expect(sends.sort()).toEqual(["demo", "mine"]);
    const snoozes = JSON.parse(backing.getItem("winnow.snooze.v1")!);
    expect(snoozes.snoozed.map((r: { account: string }) => r.account)).toEqual(["me@example.com"]);
    expect(snoozes.woke).toEqual([]);
    expect(reread.getSnapshot().scheduled.map((r) => r.id).sort()).toEqual(["demo", "mine"]);
  });

  it("keeps only the records of accounts the registry still has", async () => {
    const backing = memoryBacking();
    const { store } = await live([mail(1, "inbox")], undefined, backing);
    store.scheduleSend(send("mine", T, { account: "me@example.com" }));
    store.scheduleSend(send("gone", T, { account: "gone@x.example", context: "c-gone" }));
    store.scheduleSend(send("via-gone", T, { account: "me@example.com", context: "c-via", from: "gone1111" }));
    store.scheduleSend(send("demo", T, { context: "c-demo" }));
    // An account whose address is not known yet: nothing can be judged, nothing goes.
    store.keepAccountRecords([{ id: "aaaa1111", email: "me@example.com" }, { id: "migr4ted", email: "" }]);
    expect(store.getSnapshot().scheduled).toHaveLength(4);
    store.keepAccountRecords([{ id: "aaaa1111", email: "ME@example.com" }]);
    expect(store.getSnapshot().scheduled.map((r) => r.id).sort()).toEqual(["demo", "mine"]);
    expect(JSON.parse(backing.getItem("winnow.scheduledSend.v1")!).sends).toHaveLength(2);
  });

  it("never dispatches another account's send, and drops one whose account is gone", async () => {
    const backing = memoryBacking();
    const fake = liveBackend([mail(1, "inbox")]);
    const store = new WinnowStore({ backend: fake.backend, storage: () => backing });
    store.enterAccount("aaaa1111", { learning: null, filterLearning: null, activeFilters: [], mailbox: null });
    await store.connect(fake.backend, { email: "me@example.com" });
    store.setAccounts([
      { id: "aaaa1111", email: "me@example.com", color: "space", notify: true, unread: null, active: true },
      { id: "bbbb2222", email: "bob@two.example", color: "plum", notify: true, unread: 0, active: false },
    ]);
    store.scheduleSend(send("mine", T, { account: "me@example.com" }));
    store.scheduleSend(send("bob", T, { account: "bob@two.example", context: "c-bob" }));
    store.scheduleSend(send("via-gone", T, { account: "me@example.com", context: "c-via", from: "cccc3333" }));
    expect(store.permitScheduled("mine")?.id).toBe("mine");
    // Bob's is Bob's: not sent from here, and kept for him.
    expect(store.permitScheduled("bob")).toBeNull();
    expect(store.getSnapshot().scheduled.some((r) => r.id === "bob")).toBe(true);
    // From an account that is no longer here: dropped, not sent.
    expect(store.permitScheduled("via-gone")).toBeNull();
    expect(store.getSnapshot().scheduled.some((r) => r.id === "via-gone")).toBe(false);
    expect(store.permitScheduled("nothing")).toBeNull();
    expect(store.scheduledSends().map((r) => r.id).sort()).toEqual(["mine"]);
  });

  it("says when a schedule could not be stored, so the caller keeps the draft's device copy", () => {
    const backing = memoryBacking();
    const { store } = demo(backing);
    expect(store.scheduleSend(send("a", T + HOUR))).toBe(true);
    const refusing = { ...backing, setItem: () => { throw new DOMException("quota", "QuotaExceededError"); } };
    const full = new WinnowStore({ seed: seed(), storage: () => refusing, now: T });
    expect(full.scheduleSend(send("b", T + HOUR, { context: "c-b" }))).toBe(false);
    expect(full.scheduledSends().map((r) => r.id)).toContain("b");
  });
});

describe("two windows of the app (STRM-290)", () => {
  const send = (id: string, sendAt: number, extra: Partial<ScheduledSend> = {}): ScheduledSend => ({
    id,
    account: "demo",
    sendAt,
    scheduledAt: T,
    mode: "new",
    context: `c-${id}`,
    draftId: `d-${id}`,
    draft: { to: ["ana@example.com"], cc: [], bcc: [], subject: `Later ${id}`, body: "Hello" },
    ...extra,
  });
  const stored = (backing: ReturnType<typeof memoryBacking>) =>
    (JSON.parse(backing.getItem("winnow.scheduledSend.v1")!).sends as ScheduledSend[]).map((r) => r.id).sort();
  const storedSnoozes = (backing: ReturnType<typeof memoryBacking>) =>
    (JSON.parse(backing.getItem("winnow.snooze.v1")!).snoozed as { key: string }[]).map((r) => r.key).sort();

  it("keeps both windows' scheduled sends when each saves from its own list", () => {
    const backing = memoryBacking();
    const a = demo(backing);
    const b = demo(backing);
    a.store.scheduleSend(send("from-a", T + HOUR));
    // b's list is stale (it never saw from-a); its save must not drop it.
    b.store.scheduleSend(send("from-b", T + 2 * HOUR));
    expect(stored(backing)).toEqual(["from-a", "from-b"]);
    expect(b.store.getSnapshot().scheduled.map((s) => s.id)).toEqual(["from-a", "from-b"]);
    // And a's next save keeps b's.
    a.store.updateScheduled("from-a", { sendAt: T + 3 * HOUR });
    expect(stored(backing)).toEqual(["from-a", "from-b"]);
  });

  it("keeps both windows' snoozes", () => {
    const backing = memoryBacking();
    const a = demo(backing);
    const b = demo(backing);
    a.store.snooze([3], T + HOUR, { undo: false });
    b.store.snooze([4], T + HOUR, { undo: false });
    expect(storedSnoozes(backing)).toEqual(["g-3", "g-4"]);
    a.store.syncDeviceRecords();
    expect(a.store.isSnoozed("g-4")).toBe(true);
  });

  it("does not bring back what the other window cancelled or sent", () => {
    const backing = memoryBacking();
    const a = demo(backing);
    a.store.scheduleSend(send("one", T + HOUR));
    a.store.scheduleSend(send("two", T + HOUR));
    const b = demo(backing);
    a.store.cancelSchedule("one");
    // b still lists "one"; saving something else must not write it back.
    b.store.updateScheduled("two", { sendAt: T + 2 * HOUR });
    expect(stored(backing)).toEqual(["two"]);
    expect(b.store.getSnapshot().scheduled.map((s) => s.id)).toEqual(["two"]);
  });

  it("will not claim a send the other window already sent", () => {
    const backing = memoryBacking();
    const a = demo(backing);
    a.store.scheduleSend(send("one", T));
    const b = demo(backing);
    // a sent it and ended the schedule.
    expect(a.store.claimScheduled("one", T)).toBe(true);
    a.store.cancelSchedule("one");
    expect(b.store.claimScheduled("one", T + 10 * 60_000)).toBe(false);
    expect(b.store.getSnapshot().scheduled).toEqual([]);
  });

  it("takes in the other window's changes on sync, keeping its own unsaved ones", () => {
    const backing = memoryBacking();
    const a = demo(backing);
    const b = demo(backing);
    a.store.scheduleSend(send("from-a", T + HOUR));
    a.store.snooze([3], T + HOUR, { undo: false });
    expect(b.store.getSnapshot().scheduled).toEqual([]);
    b.store.syncDeviceRecords();
    expect(b.store.getSnapshot().scheduled.map((s) => s.id)).toEqual(["from-a"]);
    expect(b.store.isSnoozed("g-3")).toBe(true);
    a.store.cancelSchedule("from-a");
    b.store.syncDeviceRecords();
    expect(b.store.getSnapshot().scheduled).toEqual([]);
  });

  it("still saves when storage holds nothing yet, and keeps a send storage refused", () => {
    let refuse = false;
    const inner = memoryBacking();
    const backing = {
      getItem: (key: string) => inner.getItem(key),
      setItem: (key: string, value: string) => {
        if (refuse) throw new Error("quota");
        inner.setItem(key, value);
      },
      removeItem: (key: string) => inner.removeItem(key),
    };
    const store = new WinnowStore({ seed: seed(), storage: () => backing, now: T });
    expect(store.scheduleSend(send("kept", T + HOUR))).toBe(true);
    refuse = true;
    expect(store.scheduleSend(send("memory-only", T + 2 * HOUR))).toBe(false);
    refuse = false;
    store.scheduleSend(send("later", T + 3 * HOUR));
    expect(JSON.parse(inner.getItem("winnow.scheduledSend.v1")!).sends.map((r: ScheduledSend) => r.id)).toEqual([
      "kept",
      "memory-only",
      "later",
    ]);
  });
});

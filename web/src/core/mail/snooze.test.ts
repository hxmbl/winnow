import { describe, expect, it } from "vitest";
import {
  EMPTY_SNOOZES,
  SnoozeOverlay,
  WOKE_TTL_MS,
  abandonedSnoozes,
  addSnooze,
  dueSnoozes,
  markWoke,
  parseSnoozes,
  pruneWoke,
  removeSnooze,
  repliedSnoozes,
  snoozeKeyFor,
  snoozedById,
  type SnoozeRecord,
} from "./snooze";
import type { Email, Mailbox } from "../model/email";

function mail(id: number, mailbox: Mailbox, extra: Partial<Email> = {}): Email {
  return {
    id,
    gmailId: `g-${id}`,
    sender: "a@example.com",
    mailbox,
    receivedAt: 1_000 + id,
    subject: `Message ${id}`,
    body: "",
    category: "primary",
    starred: false,
    unread: false,
    urgent: false,
    attachments: [],
    ...extra,
  };
}

const record = (key: string, gmailIds: string[], wakeAt: number, extra: Partial<SnoozeRecord> = {}): SnoozeRecord => ({
  key,
  account: "me@example.com",
  gmailIds,
  wakeAt,
  snoozedAt: 0,
  from: "inbox",
  ...extra,
});

describe("snooze records", () => {
  it("keys a conversation by its thread, a lone message by itself", () => {
    expect(snoozeKeyFor(mail(1, "inbox", { threadId: "t-1" }))).toBe("t-1");
    expect(snoozeKeyFor(mail(2, "inbox"))).toBe("g-2");
  });

  it("reads storage tolerantly: bad entries go, good ones stay", () => {
    expect(parseSnoozes(null)).toEqual(EMPTY_SNOOZES);
    expect(parseSnoozes("x")).toEqual(EMPTY_SNOOZES);
    const good = record("t-1", ["g-1"], 5);
    const parsed = parseSnoozes({ snoozed: [good, { key: 1 }, { ...good, gmailIds: [] }], woke: [{ gmailId: "g", account: "a", wokeAt: 1 }, {}] });
    expect(parsed.snoozed).toEqual([good]);
    expect(parsed.woke).toHaveLength(1);
  });

  it("replaces a conversation snoozed again, takes its messages out of other records, and of the woken", () => {
    let state = addSnooze(EMPTY_SNOOZES, record("t-1", ["g-1", "g-2"], 50));
    state = markWoke(state, "me@example.com", ["g-3"], 10);
    state = addSnooze(state, record("t-2", ["g-2", "g-3"], 20));
    expect(state.snoozed.map((r) => [r.key, r.gmailIds])).toEqual([
      ["t-2", ["g-2", "g-3"]],
      ["t-1", ["g-1"]],
    ]);
    expect(state.woke).toEqual([]);
    state = addSnooze(state, record("t-1", ["g-1"], 99));
    expect(state.snoozed.find((r) => r.key === "t-1")?.wakeAt).toBe(99);
    expect(removeSnooze(state, "me@example.com", "t-2").snoozed.map((r) => r.key)).toEqual(["t-1"]);
    expect(removeSnooze(state, "other@example.com", "t-2")).toBe(state);
  });

  it("only ever answers for one account", () => {
    const state = addSnooze(addSnooze(EMPTY_SNOOZES, record("t-1", ["g-1"], 5)), record("t-9", ["g-9"], 5, { account: "demo" }));
    expect([...snoozedById(state, "demo").keys()]).toEqual(["g-9"]);
    expect(dueSnoozes(state, "me@example.com", 10).map((r) => r.key)).toEqual(["t-1"]);
    expect(dueSnoozes(state, "me@example.com", 4)).toEqual([]);
  });

  it("wakes a conversation early when a new message arrives in it after the snooze", () => {
    const state = addSnooze(EMPTY_SNOOZES, record("t-1", ["g-1"], 1e12, { snoozedAt: 2_000 }));
    const reply = mail(5, "inbox", { threadId: "t-1", receivedAt: 3_000 });
    const old = mail(6, "inbox", { threadId: "t-1", receivedAt: 1_500 });
    expect(repliedSnoozes(state, "me@example.com", [old], 1e9).map((r) => r.key)).toEqual([]);
    expect(repliedSnoozes(state, "me@example.com", [reply], 1e9).map((r) => r.key)).toEqual(["t-1"]);
    // Not in the first minute: a sync can still be listing the conversation as it was.
    expect(repliedSnoozes(state, "me@example.com", [reply], 2_500)).toEqual([]);
  });

  it("gives up on a snooze whose mail went to the Trash elsewhere, only once every message is known", () => {
    const state = addSnooze(EMPTY_SNOOZES, record("t-1", ["g-1", "g-2"], 5));
    expect(abandonedSnoozes(state, "me@example.com", [mail(1, "trash")])).toEqual([]);
    expect(abandonedSnoozes(state, "me@example.com", [mail(1, "trash"), mail(2, "spam")]).map((r) => r.key)).toEqual(["t-1"]);
    expect(abandonedSnoozes(state, "me@example.com", [mail(1, "trash"), mail(2, "archive")])).toEqual([]);
  });

  it("keeps a woken place while the message is in the Inbox, for a week", () => {
    const state = markWoke(EMPTY_SNOOZES, "me@example.com", ["g-1", "g-2", "g-3"], 100);
    const pruned = pruneWoke(state, [mail(1, "inbox"), mail(2, "archive")], 200);
    expect(pruned.woke.map((w) => w.gmailId)).toEqual(["g-1", "g-3"]);
    expect(pruneWoke(state, [], 100 + WOKE_TTL_MS + 1).woke).toEqual([]);
    const same = markWoke(EMPTY_SNOOZES, "me@example.com", ["g-1"], 100);
    expect(pruneWoke(same, [mail(1, "inbox")], 200)).toBe(same);
  });
});

describe("the overlay", () => {
  it("keeps snoozed mail out of the Inbox and dates woken mail by its wake time", () => {
    const overlay = new SnoozeOverlay();
    let state = addSnooze(EMPTY_SNOOZES, record("g-1", ["g-1"], 99));
    state = markWoke(state, "me@example.com", ["g-2"], 9_000);
    const emails = [mail(1, "inbox"), mail(2, "inbox"), mail(3, "inbox")];
    const out = overlay.apply(emails, state, "me@example.com");
    expect(out.map((e) => [e.mailbox, e.receivedAt])).toEqual([
      ["archive", 1_001],
      ["inbox", 9_000],
      ["inbox", 1_003],
    ]);
    expect(out[2]).toBe(emails[2]);
    // The same message object gives the same copy, so per-object caches keep working.
    expect(overlay.apply(emails, state, "me@example.com")[0]).toBe(out[0]);
    // Another account's snoozes do nothing, and an untouched list comes back as itself.
    expect(overlay.apply(emails, state, "you@example.com")).toBe(emails);
    expect(overlay.apply(emails, EMPTY_SNOOZES, "me@example.com")).toBe(emails);
  });

  it("does not move a woken message's date backwards, nor touch it outside the Inbox", () => {
    const overlay = new SnoozeOverlay();
    const state = markWoke(EMPTY_SNOOZES, "me@example.com", ["g-1", "g-2"], 500);
    const emails = [mail(1, "inbox"), mail(2, "archive")];
    expect(overlay.apply(emails, state, "me@example.com")).toBe(emails);
  });
});

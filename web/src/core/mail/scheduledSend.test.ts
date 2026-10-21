import { describe, expect, it } from "vitest";
import {
  CLAIM_MS,
  addSchedule,
  dueSchedules,
  forgetAccountSchedules,
  mergeSchedules,
  scheduleDraftOwner,
  scheduleVerdict,
  parseSchedules,
  removeSchedule,
  scheduledRow,
  serializeSchedules,
  updateSchedule,
  type ScheduledSend,
} from "./scheduledSend";
import { DEVICE_COPY_BUDGET } from "./attachments";

const send = (id: string, sendAt: number, extra: Partial<ScheduledSend> = {}): ScheduledSend => ({
  id,
  account: "me@example.com",
  sendAt,
  scheduledAt: 1,
  mode: "new",
  context: "new",
  draftId: `d-${id}`,
  draft: { to: ["ana@example.com"], cc: [], bcc: [], subject: `S ${id}`, body: "Hi" },
  ...extra,
});

describe("scheduled sends", () => {
  it("reads storage tolerantly, soonest first", () => {
    expect(parseSchedules(null)).toEqual([]);
    expect(parseSchedules({ sends: "x" })).toEqual([]);
    const list = parseSchedules({ sends: [send("b", 20), { id: "bad" }, send("a", 10), { ...send("c", 5), mode: "fax" }] });
    expect(list.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("keeps one schedule per draft: scheduling the same draft again moves it", () => {
    let list = addSchedule([], send("a", 10));
    list = addSchedule(list, send("b", 5, { draftId: "d-a" }));
    expect(list.map((s) => [s.id, s.sendAt])).toEqual([["b", 5]]);
    // Without a Gmail draft (the demo), the composer context is the draft.
    list = addSchedule(addSchedule([], send("x", 1, { draftId: null, context: "reply:g-1" })), send("y", 2, { draftId: null, context: "reply:g-1" }));
    expect(list.map((s) => s.id)).toEqual(["y"]);
    expect(removeSchedule(list, "y")).toEqual([]);
  });

  it("is due once its time has come, unless it is waiting on the user or another window has it", () => {
    const list = [
      send("a", 10),
      send("b", 10, { problem: "Couldn't send." }),
      send("c", 10, { claimedAt: 95 }),
      send("d", 10, { claimedAt: 95 - CLAIM_MS - 1 }),
      send("e", 200),
      send("f", 10, { account: "demo" }),
    ];
    expect(dueSchedules(list, "me@example.com", 100).map((s) => s.id)).toEqual(["a", "d"]);
    expect(dueSchedules(list, "demo", 100).map((s) => s.id)).toEqual(["f"]);
  });

  it("clears a field patched with undefined", () => {
    const [patched] = updateSchedule([send("a", 1, { problem: "x", claimedAt: 5 })], "a", { problem: undefined, claimedAt: 9 });
    expect(patched).not.toHaveProperty("problem");
    expect(patched?.claimedAt).toBe(9);
  });

  it("stores big files by name only, as the drafts' device copy does", () => {
    const big = "A".repeat(DEVICE_COPY_BUDGET + 10);
    const stored = serializeSchedules([
      send("a", 1, { draft: { ...send("a", 1).draft, attachments: [{ id: "1", filename: "big.bin", mimeType: "x", size: 9, data: big }] } }),
    ]);
    expect(stored.sends[0]!.draft.attachments?.[0]).not.toHaveProperty("data");
    expect(stored.sends[0]!.draft.attachments?.[0]?.filename).toBe("big.bin");
  });

  it("lists as a row from the user, dated by when it goes, keeping the reply's thread", () => {
    const row = scheduledRow(send("a", 777, { draft: { ...send("a", 1).draft, threadId: "t-9" } }), { email: "me@example.com" });
    expect(row).toMatchObject({ mailbox: "scheduled", receivedAt: 777, threadId: "t-9", sender: "me@example.com", subject: "S a" });
    expect(row.scheduled).toEqual({ id: "a", sendAt: 777 });
    expect(row.to).toEqual([{ address: "ana@example.com" }]);
    expect(scheduledRow(send("a", 1), { email: "x" }).id).toBe(row.id);
  });

  it("keeps the account a send goes out from, across storage", () => {
    const stored = parseSchedules(JSON.parse(JSON.stringify(serializeSchedules([send("a", 1, { from: "bbbb2222" })]))));
    expect(stored[0]!.from).toBe("bbbb2222");
    expect(parseSchedules({ sends: [{ ...send("b", 1), from: 7 }] })).toEqual([]);
  });

  it("goes out only under the open account, and only while every account it names is here", () => {
    const accounts = [{ id: "aaaa1111" }, { id: "bbbb2222" }];
    const open = { account: "me@example.com", openId: "aaaa1111", accounts };
    expect(scheduleVerdict(send("a", 1), open)).toBe("send");
    // Another account's, or the demo's: never sent here, never dropped from here.
    expect(scheduleVerdict(send("a", 1, { account: "other@example.com" }), open)).toBe("skip");
    expect(scheduleVerdict(send("a", 1, { account: "demo" }), open)).toBe("skip");
    expect(scheduleVerdict(send("a", 1, { account: "ME@example.com" }), open)).toBe("send");
    // From another account that is still signed in: it goes, through that account.
    expect(scheduleVerdict(send("a", 1, { from: "bbbb2222" }), open)).toBe("send");
    // From an account that is gone, or under an open account the registry no longer has: dropped.
    expect(scheduleVerdict(send("a", 1, { from: "cccc3333" }), open)).toBe("drop");
    expect(scheduleVerdict(send("a", 1), { ...open, accounts: [{ id: "bbbb2222" }] })).toBe("drop");
    // The demo sends its own.
    expect(scheduleVerdict(send("a", 1, { account: "demo" }), { account: "demo", openId: null, accounts: [] })).toBe("send");
  });

  it("forgets one account's sends: its own and those going out from it", () => {
    const list = [
      send("mine", 1),
      send("theirs", 2, { account: "Bob@Two.example" }),
      send("via", 3, { from: "bbbb2222" }),
      send("demo", 4, { account: "demo" }),
    ];
    expect(forgetAccountSchedules(list, "bob@two.example", "bbbb2222").map((s) => s.id)).toEqual(["mine", "demo"]);
    expect(forgetAccountSchedules(list, "", "bbbb2222").map((s) => s.id)).toEqual(["mine", "theirs", "demo"]);
  });
});

describe("whose draft a scheduled send is (STRM-289)", () => {
  const accounts = [
    { id: "aaaa1111", email: "me@example.com" },
    { id: "bbbb2222", email: "bob@two.example" },
  ];

  it("is the open account's when it has no From of its own, or its From is the open one", () => {
    expect(scheduleDraftOwner(send("a", 1), { openId: "aaaa1111", accounts })).toEqual({ kind: "open" });
    expect(scheduleDraftOwner(send("a", 1, { from: "aaaa1111" }), { openId: "aaaa1111", accounts })).toEqual({ kind: "open" });
    expect(scheduleDraftOwner(send("a", 1), { openId: null, accounts: [] })).toEqual({ kind: "open" });
  });

  it("is the From account's when that is another signed-in account", () => {
    expect(scheduleDraftOwner(send("a", 1, { from: "bbbb2222" }), { openId: "aaaa1111", accounts })).toEqual({
      kind: "other",
      id: "bbbb2222",
      email: "bob@two.example",
    });
  });

  it("is gone when the From account is no longer signed in (or its address is not known yet)", () => {
    expect(scheduleDraftOwner(send("a", 1, { from: "cccc3333" }), { openId: "aaaa1111", accounts })).toEqual({
      kind: "gone",
      id: "cccc3333",
    });
    expect(
      scheduleDraftOwner(send("a", 1, { from: "bbbb2222" }), { openId: "aaaa1111", accounts: [{ id: "bbbb2222", email: " " }] }),
    ).toEqual({ kind: "gone", id: "bbbb2222" });
  });
});

describe("merging two windows' sends (STRM-290)", () => {
  it("keeps both windows' new sends, soonest first", () => {
    const base = [send("a", 10)];
    expect(mergeSchedules(base, [...base, send("mine", 30)], [...base, send("theirs", 20)]).map((s) => s.id)).toEqual([
      "a",
      "theirs",
      "mine",
    ]);
  });

  it("never brings back a send the other window sent or cancelled", () => {
    const base = [send("a", 10), send("b", 20)];
    const mine = updateSchedule(base, "a", { claimedAt: 5 });
    expect(mergeSchedules(base, mine, [send("b", 20)]).map((s) => s.id)).toEqual(["b"]);
  });

  it("does not count a big file kept only in memory as a change", () => {
    const big = { id: "1", filename: "big.bin", mimeType: "x", size: 9, data: "A".repeat(DEVICE_COPY_BUDGET + 10) };
    const withFile = send("a", 10, { draft: { ...send("a", 10).draft, attachments: [big] } });
    const stored = parseSchedules(serializeSchedules([withFile]));
    // The other window moved its time; this one only holds the file in memory.
    const theirs = [{ ...stored[0]!, sendAt: 99 }];
    expect(mergeSchedules(stored, [withFile], theirs)[0]!.sendAt).toBe(99);
  });
});

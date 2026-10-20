import { describe, expect, it } from "vitest";
import {
  CLAIM_MS,
  addSchedule,
  dueSchedules,
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
});

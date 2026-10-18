import { describe, expect, it } from "vitest";
import { builtinFilter, senderFilter } from "../core/model/signals";
import {
  CELEBRATION_MS,
  CLEAR_HAPTIC,
  CLEAR_LINES,
  clearDetail,
  clearHeadline,
  dayPart,
  emptyKindFor,
  justCleared,
  quietLine,
  viewKey,
} from "./inboxClear";

const inbox = { mailbox: "inbox" as const, filters: [] };

describe("emptyKindFor", () => {
  it("an empty Inbox is the clear state", () => {
    expect(emptyKindFor("mailbox", inbox)).toEqual({ kind: "clear", scope: "inbox" });
  });

  it("one emptied smart filter in the Inbox is clear too, named", () => {
    expect(emptyKindFor("filters", { mailbox: "inbox", filters: [builtinFilter("important")] })).toEqual({
      kind: "clear",
      scope: "filter",
      label: "Important",
    });
  });

  it("an empty folder is the quiet state, named", () => {
    expect(emptyKindFor("mailbox", { mailbox: "trash", filters: [] })).toEqual({ kind: "quiet", scope: "folder", label: "Trash" });
    expect(emptyKindFor("mailbox", { mailbox: "sent", filters: [] })).toMatchObject({ kind: "quiet", label: "Sent" });
  });

  it("filters that match nothing elsewhere, together, or by sender are quiet", () => {
    expect(emptyKindFor("filters", { mailbox: "archive", filters: [builtinFilter("important")] })).toEqual({ kind: "quiet", scope: "filter" });
    expect(
      emptyKindFor("filters", { mailbox: "inbox", filters: [builtinFilter("important"), builtinFilter("shipping")] }),
    ).toEqual({ kind: "quiet", scope: "filter" });
    expect(emptyKindFor("filters", { mailbox: "inbox", filters: [senderFilter("a@b.c")] })).toEqual({ kind: "quiet", scope: "filter" });
  });

  it("an Inbox with only held-back junk left is clear too: nothing needs attention", () => {
    expect(emptyKindFor("noSignal", inbox)).toEqual({ kind: "clear", scope: "inbox", heldBack: true });
    expect(clearDetail({ kind: "clear", scope: "inbox", heldBack: true })).toMatch(/holding back/);
    expect(emptyKindFor("noSignal", { mailbox: "archive", filters: [] })).toBeNull();
  });

  it("an empty label being browsed is a quiet folder named for it, never a clear Inbox", () => {
    const travel = { mailbox: "inbox" as const, filters: [], label: { id: "Label_3", name: "Travel" } };
    expect(emptyKindFor("mailbox", travel)).toEqual({ kind: "quiet", scope: "folder", label: "Travel" });
    expect(emptyKindFor("filters", { ...travel, filters: [builtinFilter("important")] })).toEqual({ kind: "quiet", scope: "filter" });
    expect(emptyKindFor("noSignal", travel)).toBeNull();
  });

  it("leaves search and non-empty lists to the remedy screens", () => {
    expect(emptyKindFor("search", inbox)).toBeNull();
    expect(emptyKindFor(null, inbox)).toBeNull();
    expect(emptyKindFor("mailbox", undefined)).toBeNull();
  });
});

describe("dayPart", () => {
  it.each([
    [0, "night"], [4, "night"], [5, "morning"], [11, "morning"], [12, "afternoon"],
    [16, "afternoon"], [17, "evening"], [21, "evening"], [22, "night"], [23, "night"],
  ] as const)("%i:00 is %s", (hour, part) => {
    expect(dayPart(hour)).toBe(part);
  });

  it("wraps out-of-range hours", () => {
    expect(dayPart(24 + 9)).toBe("morning");
    expect(dayPart(-1)).toBe("night");
  });
});

describe("clearHeadline", () => {
  it("follows the time of day", () => {
    const at = (hour: number) => new Date(2026, 9, 18, hour, 30);
    expect(CLEAR_LINES.morning).toContain(clearHeadline({ kind: "clear", scope: "inbox" }, at(8)));
    expect(CLEAR_LINES.afternoon).toContain(clearHeadline({ kind: "clear", scope: "inbox" }, at(14)));
    expect(CLEAR_LINES.evening).toContain(clearHeadline({ kind: "clear", scope: "inbox" }, at(19)));
    expect(CLEAR_LINES.night).toContain(clearHeadline({ kind: "clear", scope: "inbox" }, at(2)));
  });

  it("holds still within a day and varies across days", () => {
    const kind = { kind: "clear", scope: "inbox" } as const;
    expect(clearHeadline(kind, new Date(2026, 9, 18, 9, 0))).toBe(clearHeadline(kind, new Date(2026, 9, 18, 11, 59)));
    const week = new Set(Array.from({ length: 7 }, (_, d) => clearHeadline(kind, new Date(2026, 9, 18 + d, 9))));
    expect(week.size).toBeGreaterThan(1);
  });

  it("names the filter for a cleared smart filter", () => {
    expect(clearHeadline({ kind: "clear", scope: "filter", label: "Shipping" }, new Date())).toBe("Nothing left in Shipping.");
    expect(clearDetail({ kind: "clear", scope: "filter", label: "Shipping" })).toMatch(/filter/);
    expect(clearDetail({ kind: "clear", scope: "inbox" })).toMatch(/Inbox is clear/);
  });

  it("never claims more than the list: no 'caught up', no exclamation marks", () => {
    for (const line of Object.values(CLEAR_LINES).flat()) {
      expect(line).not.toMatch(/caught up|!/i);
      expect(line.length).toBeLessThan(48);
    }
  });
});

describe("quietLine", () => {
  it("says the folder is empty, or the filters match nothing", () => {
    expect(quietLine({ kind: "quiet", scope: "folder", label: "Archive" })).toBe("Archive is empty.");
    expect(quietLine({ kind: "quiet", scope: "filter" })).toBe("Nothing matches those filters.");
  });

  it("takes the mailbox's own wording when it has one", () => {
    expect(quietLine({ kind: "quiet", scope: "folder", label: "Drafts" }, "No drafts.")).toBe("No drafts.");
  });
});

describe("justCleared", () => {
  const key = viewKey(inbox);
  it("is the moment the same view goes from rows to none", () => {
    expect(justCleared({ key, count: 1 }, { key, count: 0 })).toBe(true);
    expect(justCleared({ key, count: 30 }, { key, count: 0 })).toBe(true);
  });

  it("is not opening onto an empty view, switching views, or staying empty", () => {
    expect(justCleared(null, { key, count: 0 })).toBe(false);
    expect(justCleared({ key: "trash", count: 3 }, { key, count: 0 })).toBe(false);
    expect(justCleared({ key, count: 0 }, { key, count: 0 })).toBe(false);
    expect(justCleared({ key, count: 2 }, { key, count: 1 })).toBe(false);
  });
});

describe("viewKey", () => {
  it("names the mailbox and filters, order-insensitively", () => {
    const a = viewKey({ mailbox: "inbox", filters: [builtinFilter("important"), builtinFilter("shipping")] });
    const b = viewKey({ mailbox: "inbox", filters: [builtinFilter("shipping"), builtinFilter("important")] });
    expect(a).toBe(b);
    expect(a).not.toBe(viewKey(inbox));
    expect(viewKey({ mailbox: "archive", filters: [] })).not.toBe(viewKey(inbox));
    expect(viewKey(undefined)).toBe("");
    // Leaving a full Inbox for an empty label is a different view, not a clearing.
    expect(viewKey({ ...inbox, label: { id: "Label_3", name: "Travel" } })).not.toBe(viewKey(inbox));
    expect(viewKey({ ...inbox, label: null })).toBe(viewKey(inbox));
  });
});

describe("the motion", () => {
  it("is short, and the haptic is a gentle tap", () => {
    expect(CELEBRATION_MS).toBeLessThanOrEqual(2000);
    expect(CLEAR_HAPTIC.reduce((a, b) => a + b, 0)).toBeLessThan(200);
  });
});

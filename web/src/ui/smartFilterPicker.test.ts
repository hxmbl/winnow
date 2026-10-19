import { describe, expect, it } from "vitest";
import { changeNotice, clickInto, pickerRows, pickerTitle } from "./smartFilterPicker";
import { learntSummary, ruleText } from "./smartFilterSettings";
import { buildRowMenu } from "./menus";
import { FilterLearning, LEARNABLE_FILTERS } from "../core/learn/filterLearning";
import type { Email } from "../core/model/email";

const email: Email = {
  id: 1,
  gmailId: "g1",
  sender: "noreply@evri.com",
  mailbox: "inbox",
  receivedAt: 1,
  subject: "Your Evri delivery is coming today",
  body: "Tracking: H01HYA0012345678",
  category: "updates",
  starred: false,
  unread: true,
  urgent: false,
  attachments: [],
};

describe("the picker's status line (R7)", () => {
  it("says Moved only when membership changed", () => {
    expect(changeNotice("Deliveries", { into: true, moved: 1, unsafe: 0, already: 0 }, 1)).toBe("Moved into Deliveries.");
    expect(changeNotice("Promos", { into: false, moved: 2, unsafe: 0, already: 0 }, 2)).toBe("Moved 2 messages out of Promos.");
    expect(changeNotice("Promos", { into: true, moved: 2, unsafe: 0, already: 3 }, 5)).toBe("Moved 2 of 5 messages into Promos.");
    expect(changeNotice("Urgent", { into: true, moved: 0, unsafe: 0, already: 1 }, 1)).toBe("Already in Urgent.");
    expect(changeNotice("Urgent", { into: false, moved: 0, unsafe: 0, already: 1 }, 1)).toBe("Not in Urgent.");
    for (const text of [
      changeNotice("Urgent", { into: true, moved: 0, unsafe: 0, already: 1 }, 1),
      changeNotice("Urgent", { into: true, moved: 0, unsafe: 1, already: 0 }, 1),
    ]) {
      expect(text).not.toMatch(/Moved/);
    }
  });

  it("tells you to mark unsafe mail not spam first", () => {
    expect(changeNotice("Important", { into: true, moved: 0, unsafe: 1, already: 0 }, 1)).toBe(
      "This message looks unsafe. Mark it not spam first to put it in Important.",
    );
    expect(changeNotice("Important", { into: true, moved: 1, unsafe: 2, already: 0 }, 3)).toBe(
      "Moved 1 of 3 messages into Important. 2 look unsafe. Mark them not spam first to put them in Important.",
    );
  });
});

describe("the picker", () => {
  it("lists every learnable filter in rail order, ticked from membership", () => {
    const rows = pickerRows(new Map([["shipping", "all"], ["receipts", "some"]]));
    expect(rows.map((row) => row.filter)).toEqual([...LEARNABLE_FILTERS]);
    expect(rows.find((row) => row.filter === "shipping")).toEqual({ filter: "shipping", label: "Deliveries", check: "all" });
    expect(rows.find((row) => row.filter === "receipts")?.check).toBe("some");
    expect(rows.find((row) => row.filter === "travel")?.check).toBe("none");
  });

  it("ticks in on a clear or mixed box, out on a ticked one", () => {
    expect(clickInto("none")).toBe(true);
    expect(clickInto("some")).toBe(true);
    expect(clickInto("all")).toBe(false);
  });

  it("titles the picker by how many messages it is for", () => {
    expect(pickerTitle(1)).toBe("Smart filters");
    expect(pickerTitle(3)).toBe("Smart filters for 3 messages");
  });

  it("is in the row menu only where it is offered", () => {
    const base = { count: 1, mailbox: "inbox" as const, anyUnread: true };
    const noop = () => undefined;
    const actions = { reply: noop, replyAll: noop, forward: noop, archive: noop, trash: noop, setRead: noop, move: noop, toggleMuteSender: noop, findFrom: noop, findSubject: noop, openInGmail: noop };
    const ids = (items: ReturnType<typeof buildRowMenu>) => items.flatMap((item) => ("id" in item ? [item.id] : []));
    expect(ids(buildRowMenu({ ...base, actions: { ...actions, changeFilters: noop } }))).toContain("change-filters");
    expect(ids(buildRowMenu({ ...base, actions }))).not.toContain("change-filters");
  });
});

describe("Settings → Smart filters", () => {
  it("summarises in words, with counts of corrections and rules only", () => {
    expect(learntSummary(FilterLearning.empty())).toMatch(/^Nothing yet/);
    const model = FilterLearning.empty().record(email, "shipping", true, 1);
    expect(learntSummary(model)).toBe("1 correction across 1 filter, and 1 sender rule. Kept on this device only.");
  });

  it("reads a sender rule as a sentence", () => {
    const once = FilterLearning.empty().record(email, "shipping", true, 1);
    expect(ruleText(once.senderRules()[0])).toBe(`Mail from ${once.senderRules()[0].key} goes in Deliveries (you moved 1 in)`);
    expect(once.senderRules()[0].kind).toBe("address");
    const [rule] = once.record({ ...email, gmailId: "second", sender: "depot@evri.com" }, "shipping", true, 2).senderRules();
    expect(ruleText(rule)).toBe("Mail from anyone at evri.com goes in Deliveries (you moved 2 in)");
    expect(ruleText({ filter: "promotional", key: "sam@gmail.com", kind: "address", into: false, count: 2 })).toBe(
      "Mail from sam@gmail.com stays out of Promos (you moved 2 out)",
    );
  });
});

/**
 * The filter rail's contents.
 *
 * The rule worth testing here is the one about active senders keeping their pill.
 * It looks like a small cosmetic decision and it is not: getting it wrong makes a
 * filter that the user turned on impossible to turn off with the pointer, which
 * is a control that has silently stopped existing.
 */

import { describe, expect, it } from "vitest";
import { buildPills, digitFor } from "./rail";
import { builtinFilter, senderFilter, type BuiltinSmartFilter } from "../core/model/signals";

const RAIL: BuiltinSmartFilter[] = ["important", "needs_action", "unsafe"];

const COUNTS = new Map<BuiltinSmartFilter, number>([
  ["important", 4],
  ["needs_action", 2],
  ["unsafe", 1],
]);

const SENDERS = ["ada@example.com", "grace@example.com", "alan@example.com"];
const SENDER_COUNTS = new Map<string, number>([
  ["ada@example.com", 9],
  ["grace@example.com", 5],
  ["alan@example.com", 1],
]);

const ids = (pills: ReturnType<typeof buildPills>) =>
  pills.map((pill) => (pill.id.kind === "sender" ? pill.id.sender : pill.id.id));

describe("buildPills", () => {
  it("puts the buckets first, in the store's order", () => {
    // The order is the classifier's opinion, so this must not re-sort.
    expect(ids(buildPills(RAIL, COUNTS, SENDERS, SENDER_COUNTS, []))).toEqual([
      "important",
      "needs_action",
      "unsafe",
      "ada@example.com",
      "grace@example.com",
      "alan@example.com",
    ]);
  });

  it("carries each bucket's count through", () => {
    const pills = buildPills(RAIL, COUNTS, SENDERS, SENDER_COUNTS, []);
    expect(pills[0].count).toBe(4);
    expect(pills[0].label).toBe("Important");
  });

  it("keeps an active sender's pill so it can be turned off", () => {
    // The regression this exists for: the pill that turned the filter on used to
    // disappear, leaving "All" as the only way back.
    const pills = buildPills(RAIL, COUNTS, SENDERS, SENDER_COUNTS, [
      senderFilter("grace@example.com"),
    ]);
    expect(ids(pills)).toContain("grace@example.com");
  });

  it("keeps an active sender that has fallen out of the top-N", () => {
    // The ranking shifts as mail arrives, so a sender can drop off the rail while
    // its filter is still applied. Dropping the pill would leave the filter on
    // with no visible control — the app would look like it had lost state.
    const pills = buildPills(RAIL, COUNTS, ["ada@example.com"], SENDER_COUNTS, [
      senderFilter("alan@example.com"),
    ]);
    expect(ids(pills)).toContain("alan@example.com");
    // And it keeps its real count, not zero.
    expect(pills.find((p) => p.id.kind === "sender" && p.id.sender === "alan@example.com")?.count)
      .toBe(1);
  });

  it("does not duplicate an active sender that is also ranked", () => {
    const pills = buildPills(RAIL, COUNTS, SENDERS, SENDER_COUNTS, [
      senderFilter("ada@example.com"),
    ]);
    const senders = pills.filter((p) => p.id.kind === "sender");
    expect(senders).toHaveLength(3);
  });

  it("ignores an active bucket that is not in the rail", () => {
    // A filter persisted from an older build, naming a bucket the current rail
    // does not show — a bucket that has since been dropped, or one the ranking
    // has put out of the top-N. It must not appear as a pill the user cannot
    // recognise, and it must not break the rail either.
    const narrowed: BuiltinSmartFilter[] = ["important"];
    const pills = buildPills(narrowed, COUNTS, SENDERS, SENDER_COUNTS, [
      builtinFilter("shipping"),
    ]);
    expect(ids(pills)).not.toContain("shipping");
    expect(ids(pills)).toContain("important");
  });

  it("gives a bucket with no count a zero rather than nothing", () => {
    // An empty bucket still gets a pill: a filter that shows nothing and a filter
    // you cannot select are different, and hiding the pill hides the latter.
    const pills = buildPills(["important"], new Map(), [], new Map(), []);
    expect(pills[0].count).toBe(0);
  });
});

describe("digitFor", () => {
  it("numbers the first nine positions", () => {
    expect(digitFor(0)).toBe("1");
    expect(digitFor(8)).toBe("9");
  });

  it("gives nothing past the ninth", () => {
    // There is no key for a tenth position, so printing a digit would be
    // promising a shortcut that does not exist.
    expect(digitFor(9)).toBeNull();
    expect(digitFor(20)).toBeNull();
  });
});
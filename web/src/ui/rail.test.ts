/**
 * The filter rail's contents.
 *
 * The rule worth testing here is active senders keeping their pill: getting it wrong
 * makes a filter the user turned on impossible to turn off with the pointer, a control
 * that has silently stopped existing.
 */

import { describe, expect, it } from "vitest";
import { buildPills, digitFor, scrollToReveal, stepRail, wheelPixels, type RailGeometry } from "./rail";
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
    // The pill that turned the filter on must not disappear, leaving "All" as the
    // only way back.
    const pills = buildPills(RAIL, COUNTS, SENDERS, SENDER_COUNTS, [
      senderFilter("grace@example.com"),
    ]);
    expect(ids(pills)).toContain("grace@example.com");
  });

  it("keeps an active sender that has fallen out of the top-N", () => {
    // The ranking shifts as mail arrives, so a sender can drop off the rail while its
    // filter is still applied — dropping the pill would leave the filter on with no
    // visible control.
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
    // A filter persisted from an older build, naming a bucket the current rail does
    // not show. It must not appear as a pill the user cannot recognise, and it must
    // not break the rail either.
    const narrowed: BuiltinSmartFilter[] = ["important"];
    const pills = buildPills(narrowed, COUNTS, SENDERS, SENDER_COUNTS, [
      builtinFilter("shipping"),
    ]);
    expect(ids(pills)).not.toContain("shipping");
    expect(ids(pills)).toContain("important");
  });

  it("gives a bucket with no count a zero rather than nothing", () => {
    // An empty bucket still gets a pill: a filter that shows nothing and a filter you
    // cannot select are different, and hiding the pill hides the latter.
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
    // There is no key for a tenth position, so printing a digit would promise a
    // shortcut that does not exist.
    expect(digitFor(9)).toBeNull();
    expect(digitFor(20)).toBeNull();
  });
});
describe("rail scrolling", () => {
  // Five 100px tabs with 10px gaps after a 44px mark, in a 300px rail whose last 48px
  // are the fade and the step button.
  const tabs = [0, 1, 2, 3, 4].map((i) => [44 + i * 110, 44 + i * 110 + 100] as const);
  const base: RailGeometry = {
    tabs,
    scrollLeft: 0,
    clientWidth: 300,
    scrollWidth: 44 + 5 * 110 - 10,
    startInset: 44,
    endInset: 48,
  };

  it("leaves a tab that is already in the clear alone", () => {
    expect(scrollToReveal(base, tabs[0])).toBeNull();
  });

  it("brings a tab under the end fade fully clear of it", () => {
    // Tab 2 spans 264–364; the clear area ends at 300 - 48 = 252.
    const next = scrollToReveal(base, tabs[2]);
    expect(next).toBe(364 - 300 + 48);
    expect(tabs[2][1]).toBeLessThanOrEqual(next! + base.clientWidth - base.endInset);
  });

  it("brings a tab hidden behind the mark out from under it", () => {
    const scrolled = { ...base, scrollLeft: 200 };
    const next = scrollToReveal(scrolled, tabs[1]);
    expect(next).toBe(154 - 44);
    expect(tabs[1][0]).toBeGreaterThanOrEqual(next! + base.startInset);
  });

  it("never scrolls past either end", () => {
    expect(scrollToReveal({ ...base, scrollLeft: 50 }, tabs[0])).toBe(0);
    const max = base.scrollWidth - base.clientWidth;
    expect(scrollToReveal(base, tabs[4])).toBe(max);
  });

  it("steps forward so the cut-off tab becomes the first one after the mark", () => {
    // Tab 1 (154–254) pokes 2px into the fade, so it is the one cut off.
    expect(stepRail(base, 1)).toBe(154 - 44);
  });

  it("steps back so the tab cut off at the start becomes the last before the fade", () => {
    const max = base.scrollWidth - base.clientWidth;
    const atEnd = { ...base, scrollLeft: max };
    const back = stepRail(atEnd, -1);
    expect(back).toBeLessThan(max);
    expect(back).toBeGreaterThanOrEqual(0);
  });

  it("pages by the clear width when one tab is wider than the rail", () => {
    const wide: RailGeometry = { ...base, tabs: [[44, 1000]], scrollWidth: 1000 };
    expect(stepRail(wide, 1)).toBe(300 - 44 - 48);
  });

  it("stays inside the scroll range", () => {
    const max = base.scrollWidth - base.clientWidth;
    expect(stepRail({ ...base, scrollLeft: max }, 1)).toBe(max);
    expect(stepRail(base, -1)).toBe(0);
  });
});

describe("pill colours", () => {
  it("gives every pill a colour: buckets their own, senders one from their domain", () => {
    const pills = buildPills(RAIL, COUNTS, SENDERS, SENDER_COUNTS, []);
    for (const pill of pills) {
      expect(pill.hue.h).toBeGreaterThanOrEqual(0);
      expect(pill.hue.h).toBeLessThan(360);
      expect(pill.hue.s).toBeGreaterThan(0);
    }
    const hues = pills.filter((pill) => pill.id.kind === "builtin").map((pill) => `${pill.hue.h}/${pill.hue.s}`);
    expect(new Set(hues).size).toBe(hues.length);
    // Same domain, same colour; and quieter than any bucket's.
    const senders = pills.filter((pill) => pill.id.kind === "sender");
    expect(new Set(senders.map((pill) => pill.hue.h)).size).toBe(1);
    for (const sender of senders) expect(sender.hue.s).toBeLessThanOrEqual(24);
  });

  it("turns every bucket on the rail into a pill, in order, with nothing marked hidden", () => {
    const pills = buildPills(RAIL, COUNTS, [], new Map(), []);
    expect(pills.map((pill) => (pill.id.kind === "builtin" ? pill.id.id : null))).toEqual([...RAIL]);
    for (const pill of pills) expect(pill).not.toHaveProperty("muted");
  });

  it("an appended active sender gets its colour too", () => {
    const pills = buildPills(RAIL, COUNTS, [], SENDER_COUNTS, [senderFilter("zed@other.test")]);
    expect(pills.find((pill) => pill.id.kind === "sender")?.hue.s).toBeGreaterThan(0);
  });
});

describe("rail edge cases", () => {
  const wide: RailGeometry = {
    // A 600px sender pill in a rail whose clear area is 400px.
    tabs: [
      [0, 100],
      [104, 704],
      [708, 800],
    ],
    scrollLeft: 0,
    clientWidth: 500,
    scrollWidth: 800,
    startInset: 44,
    endInset: 56,
  };

  it("reveals the start of a tab wider than the clear area, not its end", () => {
    // Coming from the left: its start lines up with the clear area's start.
    expect(scrollToReveal(wide, wide.tabs[1])).toBe(104 - 44);
    // Coming from the right (scrolled past it), the same.
    expect(scrollToReveal({ ...wide, scrollLeft: 300 }, wide.tabs[1])).toBe(104 - 44);
  });

  it("clamps the reveal at both ends of the rail", () => {
    expect(scrollToReveal({ ...wide, scrollLeft: 300 }, wide.tabs[0])).toBe(0);
    expect(scrollToReveal(wide, wide.tabs[2])).toBe(300);
  });

  it("does not scroll a rail that has nothing to scroll", () => {
    const short: RailGeometry = { ...wide, tabs: [[0, 80]], scrollWidth: 500 };
    expect(scrollToReveal(short, [0, 80])).toBeNull();
    expect(stepRail(short, 1)).toBe(0);
    expect(stepRail(short, -1)).toBe(0);
  });

  it("steps through a tab wider than the clear area by pages, never backwards", () => {
    const next = stepRail({ ...wide, scrollLeft: 60 }, 1);
    expect(next).toBeGreaterThan(60);
  });
});

describe("wheelPixels", () => {
  it("passes pixel deltas through", () => {
    expect(wheelPixels(120, 0, 500)).toBe(120);
  });

  it("turns Firefox's line deltas into pixels", () => {
    expect(wheelPixels(3, 1, 500)).toBe(48);
    expect(wheelPixels(-3, 1, 500)).toBe(-48);
  });

  it("turns page deltas into the rail's width", () => {
    expect(wheelPixels(1, 2, 500)).toBe(500);
    expect(wheelPixels(1, 2, 0)).toBe(1);
  });

  it("ignores a delta that is not a number", () => {
    expect(wheelPixels(Number.NaN, 0, 500)).toBe(0);
  });
});

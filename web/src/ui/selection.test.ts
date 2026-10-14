import { describe, expect, it } from "vitest";
import {
  LONG_PRESS_MS,
  LongPress,
  TOUCH_SLOP,
  dragSelection,
  orderedSelection,
  pruneSelection,
  rangeBetween,
  shiftSelection,
  toggleId,
} from "./selection";

const order = [10, 20, 30, 40, 50];

describe("ranges", () => {
  it("runs in list order whichever end the drag started from", () => {
    expect(rangeBetween(order, 20, 40)).toEqual([20, 30, 40]);
    expect(rangeBetween(order, 40, 20)).toEqual([20, 30, 40]);
    expect(rangeBetween(order, 30, 30)).toEqual([30]);
  });

  it("falls back to whichever end still exists", () => {
    expect(rangeBetween(order, 99, 30)).toEqual([30]);
    expect(rangeBetween(order, 30, 99)).toEqual([30]);
    expect(rangeBetween(order, 98, 99)).toEqual([]);
  });
});

describe("drag", () => {
  it("selects every row between the press and the pointer", () => {
    expect([...dragSelection(new Set(), order, 20, 50)]).toEqual([20, 30, 40, 50]);
  });

  it("shrinks when the pointer comes back, because it is recomputed from the base", () => {
    const base = new Set<number>();
    dragSelection(base, order, 20, 50);
    expect([...dragSelection(base, order, 20, 30)]).toEqual([20, 30]);
  });

  it("adds to an existing selection when it started with cmd/ctrl", () => {
    expect([...dragSelection(new Set([10]), order, 40, 50)].sort()).toEqual([10, 40, 50]);
  });
});

describe("clicks with modifiers", () => {
  it("toggles one", () => {
    expect([...toggleId(new Set([10]), 20)]).toEqual([10, 20]);
    expect([...toggleId(new Set([10, 20]), 20)]).toEqual([10]);
  });

  it("shift-click replaces with the range from the anchor, or adds with cmd", () => {
    expect([...shiftSelection(new Set([50]), order, 20, 40, false)]).toEqual([20, 30, 40]);
    expect([...shiftSelection(new Set([50]), order, 20, 40, true)].sort()).toEqual([20, 30, 40, 50]);
    expect([...shiftSelection(new Set(), order, null, 30, false)]).toEqual([30]);
  });
});

describe("keeping the selection honest", () => {
  it("drops rows that left the list, and keeps identity when nothing did", () => {
    const selection = new Set([20, 30]);
    expect(pruneSelection(selection, order)).toBe(selection);
    expect([...pruneSelection(selection, [10, 30])]).toEqual([30]);
  });

  it("orders a batch top to bottom", () => {
    expect(orderedSelection(new Set([50, 10, 30]), order)).toEqual([10, 30, 50]);
  });
});

describe("long-press", () => {
  it("fires once after the hold, and reports it on lift so the click is eaten", () => {
    const press = new LongPress();
    press.down(30, 100, 100, 0);
    expect(press.tick(LONG_PRESS_MS - 1)).toBeNull();
    expect(press.tick(LONG_PRESS_MS)).toBe(30);
    expect(press.tick(LONG_PRESS_MS + 100)).toBeNull();
    expect(press.up()).toBe(true);
    expect(press.up()).toBe(false);
  });

  it("is a scroll, not a press, once the finger moves past the slop", () => {
    const press = new LongPress();
    press.down(30, 100, 100, 0);
    expect(press.move(100, 100 + TOUCH_SLOP - 1)).toBe(true);
    expect(press.move(100, 100 + TOUCH_SLOP + 5)).toBe(false);
    expect(press.tick(LONG_PRESS_MS * 2)).toBeNull();
    expect(press.up()).toBe(false);
  });

  it("a short tap never fires", () => {
    const press = new LongPress();
    press.down(30, 0, 0, 0);
    expect(press.tick(100)).toBeNull();
    expect(press.up()).toBe(false);
  });
});

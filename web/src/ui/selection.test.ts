import { describe, expect, it } from "vitest";
import {
  EDGE_SCROLL_MAX,
  EDGE_SCROLL_ZONE,
  LONG_PRESS_MS,
  LongPress,
  TOUCH_SLOP,
  avatarDragBase,
  dragSelection,
  edgeScrollSpeed,
  nearestRow,
  sameSelection,
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

describe("dragging from an avatar", () => {
  it("starts fresh when nothing is selected and adds to a selection that exists", () => {
    expect([...avatarDragBase(new Set(), false)]).toEqual([]);
    expect([...avatarDragBase(new Set([4]), false)]).toEqual([4]);
    expect([...avatarDragBase(new Set([4]), true)]).toEqual([4]);
  });

  it("extends and shrinks as the pointer moves back past the anchor", () => {
    const order = [1, 2, 3, 4, 5, 6];
    const base = avatarDragBase(new Set(), false);
    expect([...dragSelection(base, order, 2, 5)]).toEqual([2, 3, 4, 5]);
    expect([...dragSelection(base, order, 2, 3)]).toEqual([2, 3]);
    // Back up past where it started: the range flips to above the anchor.
    expect([...dragSelection(base, order, 2, 1)].sort()).toEqual([1, 2]);
  });

  it("keeps what 'Select' picked when the drag adds more", () => {
    const base = avatarDragBase(new Set([6]), false);
    expect([...dragSelection(base, [1, 2, 3, 4, 5, 6], 1, 3)].sort()).toEqual([1, 2, 3, 6]);
  });
});

describe("edge scrolling", () => {
  it("is still in the middle of the list", () => {
    expect(edgeScrollSpeed(400, 100, 900)).toBe(0);
  });

  it("ramps up toward an edge and never passes the cap", () => {
    const near = edgeScrollSpeed(900 - 30, 100, 900);
    const nearer = edgeScrollSpeed(900 - 5, 100, 900);
    expect(near).toBeGreaterThan(0);
    expect(nearer).toBeGreaterThan(near);
    expect(edgeScrollSpeed(5000, 100, 900)).toBe(EDGE_SCROLL_MAX);
    expect(edgeScrollSpeed(-5000, 100, 900)).toBe(-EDGE_SCROLL_MAX);
  });

  it("scrolls up above the top", () => {
    expect(edgeScrollSpeed(105, 100, 900)).toBeLessThan(0);
    expect(edgeScrollSpeed(100 + EDGE_SCROLL_ZONE + 1, 100, 900)).toBe(0);
  });

  it("shrinks its zone for a short list so the middle still stands still", () => {
    expect(edgeScrollSpeed(150, 100, 200)).toBe(0);
    expect(edgeScrollSpeed(101, 100, 200)).toBeLessThan(0);
  });
});

describe("the row nearest the pointer", () => {
  const rows = [
    { id: 1, top: 100, bottom: 150 },
    { id: 2, top: 150, bottom: 200 },
    { id: 3, top: 230, bottom: 280 },
  ];

  it("is the row under it", () => {
    expect(nearestRow(rows, 160)).toBe(2);
  });

  it("is the last row past the end and the first above the start", () => {
    expect(nearestRow(rows, 900)).toBe(3);
    expect(nearestRow(rows, 0)).toBe(1);
  });

  it("is the closer neighbour over a gap such as a day heading", () => {
    expect(nearestRow(rows, 205)).toBe(2);
    expect(nearestRow(rows, 226)).toBe(3);
  });

  it("is null with nothing mounted", () => {
    expect(nearestRow([], 10)).toBeNull();
  });
});

describe("sameSelection", () => {
  it("compares by membership, not identity", () => {
    expect(sameSelection(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameSelection(new Set([1]), new Set([1, 2]))).toBe(false);
    expect(sameSelection(new Set([1, 3]), new Set([1, 2]))).toBe(false);
  });
});

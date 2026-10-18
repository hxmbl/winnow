/**
 * Tests for the windowing arithmetic.
 *
 * `MessageList` has no component tests — it is layout and events — so this is where the
 * "does the window land on the right rows" question is answered. Each case is a bug a
 * rendered list would hide: an off-by-one in the binary search is a blank strip at the
 * bottom of the list, and a mis-clamped `scrollTopForIndex` is the cursor refusing to
 * reach the last message.
 */

import { describe, expect, it } from "vitest";
import {
  ESTIMATED_ROW_HEIGHT,
  computeOffsets,
  indexAt,
  revealScrollTop,
  scrollTopForIndex,
  stickyIndex,
  visibleRange,
  windowKey,
} from "./windowing";

describe("computeOffsets", () => {
  it("is empty for an empty list", () => {
    const offsets = computeOffsets(0, []);
    expect(offsets).toHaveLength(1);
    expect(offsets[0]).toBe(0);
  });

  it("prefix-sums so the last entry is the total height", () => {
    const offsets = computeOffsets(3, [10, 20, 30]);
    expect([...offsets]).toEqual([0, 10, 30, 60]);
  });

  it("falls back to the estimate for an unmeasured item", () => {
    const offsets = computeOffsets(2, [null, 20]);
    expect(offsets[1]).toBe(ESTIMATED_ROW_HEIGHT);
    expect(offsets[2]).toBe(ESTIMATED_ROW_HEIGHT + 20);
  });

  it("treats a zero measurement as unmeasured rather than as a zero-height row", () => {
    // A row measured before its fonts land can report 0. Honouring that would
    // collapse the list and every later offset with it.
    const offsets = computeOffsets(2, [0, 20]);
    expect(offsets[1]).toBe(ESTIMATED_ROW_HEIGHT);
  });

  it("a per-index estimate distinguishes headers from rows", () => {
    const offsets = computeOffsets(3, [], (i) => (i === 0 ? 40 : 68));
    expect([...offsets]).toEqual([0, 40, 108, 176]);
  });
});

describe("indexAt", () => {
  const offsets = computeOffsets(4, [100, 100, 100, 100]);

  it("is 0 above the first item", () => {
    expect(indexAt(offsets, 0)).toBe(0);
    expect(indexAt(offsets, -50)).toBe(0);
  });

  it("finds the item containing y", () => {
    expect(indexAt(offsets, 0)).toBe(0);
    expect(indexAt(offsets, 99)).toBe(0);
    expect(indexAt(offsets, 100)).toBe(1);
    expect(indexAt(offsets, 250)).toBe(2);
  });

  it("clamps past the end to the last item", () => {
    expect(indexAt(offsets, 400)).toBe(3);
    expect(indexAt(offsets, 99_999)).toBe(3);
  });

  it("is 0 for an empty list", () => {
    expect(indexAt(computeOffsets(0, []), 100)).toBe(0);
  });
});

describe("visibleRange", () => {
  const offsets = computeOffsets(1000, [], () => 50); // 50,000px tall

  it("covers the viewport plus overscan", () => {
    const { start, end } = visibleRange(offsets, 1000, 800);
    // 1000/50 = item 20 is at the top; 1800/50 = 36 is at the bottom.
    expect(start).toBe(20 - 6);
    expect(end).toBe(36 + 1 + 6);
  });

  it("mounts the item a viewport edge lands exactly on", () => {
    // scrollTop 1000 is item 20's top edge, and scrollTop+height 1800 is item 36's
    // top edge. Both are visible by one pixel and must be mounted.
    const { start, end } = visibleRange(offsets, 1000, 800, 0);
    expect(start).toBe(20);
    expect(end).toBe(37);
  });

  it("clamps at the top", () => {
    const { start } = visibleRange(offsets, 0, 800);
    expect(start).toBe(0);
  });

  it("clamps at the bottom", () => {
    const { end } = visibleRange(offsets, 49_000, 800);
    expect(end).toBe(1000);
  });

  it("handles a negative scroll position without indexing before the array", () => {
    const { start, end } = visibleRange(offsets, -500, 800);
    expect(start).toBe(0);
    expect(end).toBeGreaterThan(0);
  });

  it("is empty for an empty list", () => {
    expect(visibleRange(computeOffsets(0, []), 0, 800)).toEqual({ start: 0, end: 0 });
  });

  it("mounts far fewer items than the list holds", () => {
    // The whole point: 1,000 rows must not become 1,000 DOM subtrees.
    const { start, end } = visibleRange(offsets, 0, 800);
    expect(end - start).toBeLessThan(40);
  });
});

describe("scrollTopForIndex", () => {
  const offsets = computeOffsets(1000, [], () => 50); // 50,000px tall

  it("puts the item's top at the top of the viewport", () => {
    expect(scrollTopForIndex(offsets, 100, 800)).toBe(5000);
  });

  it("clamps so a short list cannot scroll past its end", () => {
    const short = computeOffsets(5, [], () => 50); // 250px tall, 800px viewport
    expect(scrollTopForIndex(short, 4, 800)).toBe(0);
  });

  it("clamps at the end for the last items of a long list", () => {
    // Item 999 sits at 49,950px but the list only scrolls to 49,200.
    expect(scrollTopForIndex(offsets, 999, 800)).toBe(49_200);
  });

  it("clamps a negative index to the top", () => {
    expect(scrollTopForIndex(offsets, -5, 800)).toBe(0);
  });

  it("is 0 for an empty list", () => {
    expect(scrollTopForIndex(computeOffsets(0, []), 3, 800)).toBe(0);
  });
});
describe("revealScrollTop (a row under floating chrome)", () => {
  it("puts the row's top just below the covered band", () => {
    // Row at 900px in the scroller, 150px covered by the header and the pinned day.
    expect(revealScrollTop(900, 150, 5000, 800)).toBe(750);
  });
  it("never scrolls above the top, so the first rows stay where they rest", () => {
    expect(revealScrollTop(120, 150, 5000, 800)).toBe(0);
  });
  it("clamps to the end of the list", () => {
    expect(revealScrollTop(4900, 150, 5000, 800)).toBe(4200);
    expect(revealScrollTop(300, 150, 500, 800)).toBe(0);
  });
});

describe("windowKey", () => {
  // Header, five rows, header, five rows: 40 + 5×53 per day.
  const kinds = ["h", "r", "r", "r", "r", "r", "h", "r", "r", "r", "r", "r"];
  const isHeader = (i: number) => kinds[i] === "h";
  const offsets = computeOffsets(kinds.length, [], (i) => (isHeader(i) ? 40 : 53));

  it("stays the same while a scroll mounts the same rows under the same header", () => {
    const a = windowKey(offsets, isHeader, 0, 0, 120, 0);
    expect(windowKey(offsets, isHeader, 3, 0, 120, 0)).toBe(a);
    expect(windowKey(offsets, isHeader, 9, 0, 120, 0)).toBe(a);
  });

  it("changes when the mounted range or the pinned header changes", () => {
    const small = (top: number) => windowKey(offsets, isHeader, top, 0, 60, 0);
    expect(new Set([0, 60, 120, 200, 320].map(small)).size).toBeGreaterThan(2);
    expect(stickyIndex(offsets, isHeader, 10)).toBe(0);
    expect(stickyIndex(offsets, isHeader, offsets[6]! + 1)).toBe(6);
  });

  it("names no pinned header while the lead above the first day is showing", () => {
    expect(windowKey(offsets, isHeader, 0, 80, 300, 40).endsWith(":-1")).toBe(true);
  });
});

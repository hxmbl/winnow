import { describe, expect, it } from "vitest";
import { FOLD_THRESHOLD, PILL_START, pillAfterScroll, pillOpened, pillOrder, type PillScroll } from "./readerPill";

const run = (positions: number[], max = 2000, from: PillScroll = PILL_START) =>
  positions.reduce((state, top) => pillAfterScroll(state, top, max), from);

describe("the reader pill's order", () => {
  it("puts the most-used actions nearest the thumb, More furthest", () => {
    expect(pillOrder(false)).toEqual(["more", "forward", "snooze", "reply", "trash", "archive"]);
  });
  it("mirrors for the left hand", () => {
    expect(pillOrder(true)).toEqual(["archive", "trash", "reply", "snooze", "forward", "more"]);
  });
});

describe("folding while reading", () => {
  it("starts open", () => {
    expect(PILL_START.collapsed).toBe(false);
  });
  it("folds once reading down passes the threshold, not on a nudge", () => {
    expect(run([10]).collapsed).toBe(false);
    expect(run([10, 20, FOLD_THRESHOLD + 5]).collapsed).toBe(true);
  });
  it("opens again on a scroll back up", () => {
    const down = run([100, 300, 500]);
    expect(down.collapsed).toBe(true);
    expect(run([490], 2000, down).collapsed).toBe(true);
    expect(run([480, 460], 2000, down).collapsed).toBe(false);
  });
  it("opens at the end of the message and at the top", () => {
    const down = run([100, 300, 500]);
    expect(run([1990], 2000, down).collapsed).toBe(false);
    expect(run([0], 2000, down).collapsed).toBe(false);
  });
  it("folds again when reading on after a tap opened it", () => {
    const opened = pillOpened(run([100, 300, 500]));
    expect(opened.collapsed).toBe(false);
    expect(run([510], 2000, opened).collapsed).toBe(false);
    expect(run([510, 540], 2000, opened).collapsed).toBe(true);
  });
  it("never folds a message too short to scroll", () => {
    expect(run([0], 0).collapsed).toBe(false);
  });
});

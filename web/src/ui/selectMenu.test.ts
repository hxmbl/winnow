import { describe, expect, it } from "vitest";
import { nextEnabled, typeAhead } from "./selectMenu";

describe("the settings dropdown's list", () => {
  const all = [true, true, true, true];

  it("moves down and up, wrapping at both ends", () => {
    expect(nextEnabled(all, 0, 1)).toBe(1);
    expect(nextEnabled(all, 3, 1)).toBe(0);
    expect(nextEnabled(all, 0, -1)).toBe(3);
  });

  it("starts from an end for Home and End", () => {
    expect(nextEnabled(all, -1, 1)).toBe(0);
    expect(nextEnabled(all, all.length, -1)).toBe(3);
  });

  it("skips disabled values (remote images without a render proxy)", () => {
    const onlyLast = [false, false, true];
    expect(nextEnabled(onlyLast, 2, 1)).toBe(2);
    expect(nextEnabled(onlyLast, -1, 1)).toBe(2);
    expect(nextEnabled([true, false, true], 0, 1)).toBe(2);
    expect(nextEnabled([true, false, true], 2, -1)).toBe(0);
  });

  it("stays put when nothing is enabled, and copes with an empty list", () => {
    expect(nextEnabled([false, false], 1, 1)).toBe(1);
    expect(nextEnabled([], 0, 1)).toBe(0);
  });

  it("jumps to the next value starting with a typed letter, wrapping, case-insensitive", () => {
    const labels = ["System", "Light", "Dark", "Very dark"];
    expect(typeAhead(labels, all, 0, "d")).toBe(2);
    expect(typeAhead(labels, all, 2, "V")).toBe(3);
    expect(typeAhead(labels, all, 3, "s")).toBe(0);
    const repeat = ["Every minute", "Every 5 minutes", "Every hour"];
    expect(typeAhead(repeat, [true, true, true], 0, "e")).toBe(1);
    expect(typeAhead(repeat, [true, true, true], 2, "e")).toBe(0);
  });

  it("ignores other keys, no match, and disabled values", () => {
    expect(typeAhead(["Ask each time", "Always", "Never"], [false, false, true], 2, "a")).toBeNull();
    expect(typeAhead(["Date"], [true], 0, "ArrowDown")).toBeNull();
    expect(typeAhead(["Date"], [true], 0, " ")).toBeNull();
    expect(typeAhead(["Date"], [true], 0, "x")).toBeNull();
  });
});

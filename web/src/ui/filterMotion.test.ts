import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  arrival,
  enterKeyframes,
  inBand,
  leaveKeyframes,
  leavers,
  MAX_STAGGER_STEP_MS,
  moveKeyframes,
  shouldAnimateSwitch,
  staggerDelays,
  SWITCH_ENTER_DELAY_MS,
  SWITCH_ENTER_MS,
  SWITCH_ENTER_STEP_MS,
  SWITCH_LEAVE_MS,
  SWITCH_LEAVE_SPREAD_MS,
  SWITCH_LEAVE_STEP_MS,
  SWITCH_MOVE_DELAY_MS,
  SWITCH_MOVE_MS,
  SWITCH_TOTAL_MS,
} from "./filterMotion";

const band = { top: 100, bottom: 700 };
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the filter switch's motion: timings", () => {
  it("stays inside the app's motion budget", () => {
    // The index.css rule: nothing much past 220ms.
    expect(SWITCH_LEAVE_MS).toBeGreaterThanOrEqual(120);
    expect(SWITCH_LEAVE_MS).toBeLessThanOrEqual(150);
    expect(SWITCH_MOVE_DELAY_MS + SWITCH_MOVE_MS).toBeLessThanOrEqual(220);
    expect(SWITCH_LEAVE_SPREAD_MS + SWITCH_LEAVE_MS).toBeLessThanOrEqual(SWITCH_TOTAL_MS);
    expect(SWITCH_TOTAL_MS).toBeLessThanOrEqual(250);
  });

  it("staggers new rows no more than 20ms apart", () => {
    expect(SWITCH_ENTER_STEP_MS).toBeLessThanOrEqual(MAX_STAGGER_STEP_MS);
    expect(SWITCH_LEAVE_STEP_MS).toBeLessThanOrEqual(MAX_STAGGER_STEP_MS);
    expect(MAX_STAGGER_STEP_MS).toBe(20);
  });
});

describe("staggerDelays", () => {
  it("steps from the base, top to bottom", () => {
    expect(staggerDelays(3, { base: 30, step: 16, duration: 140 })).toEqual([30, 46, 62]);
  });

  it("caps so the last row is in by the total, however long the list", () => {
    const delays = staggerDelays(40, { base: SWITCH_ENTER_DELAY_MS, step: SWITCH_ENTER_STEP_MS, duration: SWITCH_ENTER_MS });
    expect(delays).toHaveLength(40);
    for (const delay of delays) expect(delay + SWITCH_ENTER_MS).toBeLessThanOrEqual(SWITCH_TOTAL_MS);
    // Never out of order, and later rows share the last slot.
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]!);
    expect(delays[39]).toBe(SWITCH_TOTAL_MS - SWITCH_ENTER_MS);
  });

  it("holds a step to 20ms whatever is asked", () => {
    expect(staggerDelays(3, { step: 90, duration: 50 })).toEqual([0, 20, 40]);
  });

  it("keeps the leaving stagger within its spread", () => {
    const delays = staggerDelays(20, { step: SWITCH_LEAVE_STEP_MS, duration: SWITCH_LEAVE_MS, spread: SWITCH_LEAVE_SPREAD_MS });
    expect(Math.max(...delays)).toBe(SWITCH_LEAVE_SPREAD_MS);
    expect(delays[0]).toBe(0);
  });

  it("is empty for nothing, and never negative", () => {
    expect(staggerDelays(0, { step: 10, duration: 100 })).toEqual([]);
    expect(staggerDelays(2, { step: 10, duration: 400 })).toEqual([0, 0]);
  });
});

describe("shouldAnimateSwitch", () => {
  const base = { previous: "inbox", next: "inbox|urgent", reducedMotion: false, listShown: true, canAnimate: true };

  it("animates a real switch", () => {
    expect(shouldAnimateSwitch(base)).toBe(true);
  });

  it("not on first mount, nor when the view is the same (a sync, a search, a sort)", () => {
    expect(shouldAnimateSwitch({ ...base, previous: null })).toBe(false);
    expect(shouldAnimateSwitch({ ...base, previous: "inbox|urgent" })).toBe(false);
  });

  it("not under reduced motion, nor with the list hidden, nor without Web Animations", () => {
    expect(shouldAnimateSwitch({ ...base, reducedMotion: true })).toBe(false);
    expect(shouldAnimateSwitch({ ...base, listShown: false })).toBe(false);
    expect(shouldAnimateSwitch({ ...base, canAnimate: false })).toBe(false);
  });
});

describe("which rows leave, stay and enter", () => {
  const before = [
    { key: "a", top: 100, bottom: 160 },
    { key: "b", top: 160, bottom: 220 },
    { key: "c", top: 220, bottom: 280 },
    { key: "far", top: 900, bottom: 960 },
    { key: "under", top: 40, bottom: 100 },
  ];

  it("leavers are the on-screen rows no longer mounted, in order down the screen", () => {
    const after = new Set(["b"]);
    expect(leavers([...before].reverse(), after, band).map((box) => box.key)).toEqual(["a", "c"]);
  });

  it("a row under the chrome or off screen leaves no ghost", () => {
    expect(leavers(before, new Set(), band).map((box) => box.key)).toEqual(["a", "b", "c"]);
  });

  it("a row that stayed slides from where it was", () => {
    expect(arrival(220, { key: "c", top: 160, bottom: 220 }, band)).toEqual({ kind: "move", from: 60 });
    expect(arrival(160, { key: "b", top: 220, bottom: 280 }, band)).toEqual({ kind: "move", from: -60 });
  });

  it("a row in the same place does not move", () => {
    expect(arrival(160.2, { key: "b", top: 160, bottom: 220 }, band)).toEqual({ kind: "still" });
  });

  it("a new row on screen fades in; one off screen is left alone", () => {
    expect(arrival(undefined, { key: "n", top: 300, bottom: 360 }, band)).toEqual({ kind: "enter" });
    expect(arrival(undefined, { key: "n", top: 800, bottom: 860 }, band)).toEqual({ kind: "still" });
  });

  it("a row that would cross more than a screen fades in rather than streaking", () => {
    expect(arrival(2000, { key: "x", top: 200, bottom: 260 }, band)).toEqual({ kind: "enter" });
  });

  it("a row off screen before and after is left alone", () => {
    expect(arrival(800, { key: "x", top: 760, bottom: 820 }, band)).toEqual({ kind: "still" });
  });

  it("inBand needs some of the box inside", () => {
    expect(inBand({ top: 40, bottom: 100 }, band)).toBe(false);
    expect(inBand({ top: 40, bottom: 101 }, band)).toBe(true);
    expect(inBand({ top: 700, bottom: 760 }, band)).toBe(false);
  });
});

describe("keyframes", () => {
  it("leave fades out with a light blur; enter fades in with a small rise; move ends in place", () => {
    expect(leaveKeyframes()).toEqual([
      { opacity: 1, filter: "blur(0px)" },
      { opacity: 0, filter: "blur(2px)" },
    ]);
    expect(enterKeyframes()[0]).toMatchObject({ opacity: 0 });
    expect(enterKeyframes()[1]).toMatchObject({ opacity: 1, transform: "translateY(0)" });
    expect(moveKeyframes(-24)).toEqual([{ transform: "translateY(-24px)" }, { transform: "translateY(0)" }]);
  });
});

describe("wiring", () => {
  it("the list animates on the mailbox and filters only, not the search or the sort", () => {
    const app = read("../App.tsx");
    expect(app).toMatch(/switchView=\{viewKey\(emptyContext\)\}/);
    expect(read("./components/MessageList.tsx")).toMatch(/useFilterSwitchMotion\(scroller, switchView, topInset, windowSettled\)/);
  });

  it("ghosts carry no row attributes, so row queries never count them", () => {
    const hook = read("./components/useFilterSwitchMotion.ts");
    expect(hook).toContain("ghostOf(");
    const ghost = read("./rowExit.ts");
    expect(ghost).toMatch(/attribute\.name\.startsWith\("data-"\)/);
  });

  it("the chip's strengths are registered, so its gradient tint can ease", () => {
    const css = read("../index.css");
    for (const name of ["--pill-a", "--pill-ring-a", "--pill-glow-a", "--wn-chip-plate"]) {
      expect(css).toMatch(new RegExp(`@property ${name} \\{`));
      expect(css).toMatch(new RegExp(`transition:[^;]*${name} var\\(--wn-chip-motion\\)`));
    }
    expect(css).toMatch(/--wn-chip-motion: 190ms;/);
    expect(css).toMatch(/--wn-chip-ease: cubic-bezier\(0\.2, 0, 0, 1\);/);
    // No state of a glass chip paints its tint from the recipe directly any more.
    expect(css).not.toMatch(/hsl\(var\(--pill-tone\) \/ var\(--wn-pill-(rest|on)\)\)/);
  });
});

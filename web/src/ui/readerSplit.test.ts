import { describe, expect, it } from "vitest";
import {
  BIG_STEP,
  DEFAULT_READER_FRACTION,
  MIN_LIST_PX,
  MIN_READER_PX,
  READER_SPLIT_KEY,
  STEP,
  clampReaderFraction,
  fractionAtPointer,
  listPercent,
  loadReaderFraction,
  percentBounds,
  saveReaderFraction,
  splitBounds,
  splitCssValue,
  stepReaderFraction,
  type SplitStorage,
} from "./readerSplit";

function memory(initial: Record<string, string> = {}): SplitStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("splitBounds", () => {
  it("resolves the pixel minimums against the width", () => {
    const { min, max, resizable } = splitBounds(1440);
    expect(resizable).toBe(true);
    expect(min * 1440).toBeCloseTo(MIN_READER_PX);
    expect((1 - max) * 1440).toBeCloseTo(MIN_LIST_PX);
  });

  it("widens the range as the window grows", () => {
    const narrow = splitBounds(1024);
    const wide = splitBounds(2560);
    expect(wide.min).toBeLessThan(narrow.min);
    expect(wide.max).toBeGreaterThan(narrow.max);
  });

  it("collapses to the default when both minimums cannot fit", () => {
    expect(splitBounds(MIN_LIST_PX + MIN_READER_PX - 1)).toEqual({
      min: DEFAULT_READER_FRACTION,
      max: DEFAULT_READER_FRACTION,
      resizable: false,
    });
    expect(splitBounds(0).resizable).toBe(false);
    expect(splitBounds(Number.NaN).resizable).toBe(false);
    expect(splitBounds(MIN_LIST_PX + MIN_READER_PX).resizable).toBe(true);
  });
});

describe("clampReaderFraction", () => {
  it("leaves a fraction inside the range alone", () => {
    expect(clampReaderFraction(0.5, 1440)).toBe(0.5);
    expect(clampReaderFraction(DEFAULT_READER_FRACTION, 1024)).toBe(DEFAULT_READER_FRACTION);
  });

  it("holds the reader at its minimum and the list at its", () => {
    expect(clampReaderFraction(0.05, 1440) * 1440).toBeCloseTo(MIN_READER_PX);
    expect((1 - clampReaderFraction(0.99, 1440)) * 1440).toBeCloseTo(MIN_LIST_PX);
  });

  it("resolves the same fraction differently at different widths", () => {
    // 30% of 1000px is under the reader's minimum; 30% of 2000px is not.
    expect(clampReaderFraction(0.3, 1000)).toBeCloseTo(MIN_READER_PX / 1000);
    expect(clampReaderFraction(0.3, 2000)).toBe(0.3);
  });

  it("treats garbage as the default", () => {
    expect(clampReaderFraction(Number.NaN, 1440)).toBe(DEFAULT_READER_FRACTION);
    expect(clampReaderFraction(Number.POSITIVE_INFINITY, 1440)).toBe(DEFAULT_READER_FRACTION);
  });
});

describe("fractionAtPointer", () => {
  it("is the share to the right of the pointer", () => {
    expect(fractionAtPointer(800, 0, 1200)).toBeCloseTo(1 / 3);
    expect(fractionAtPointer(600, 100, 1000)).toBeCloseTo(0.5);
  });

  it("clamps a pointer past either minimum", () => {
    expect(fractionAtPointer(-500, 0, 1440) * 1440).toBeCloseTo(1440 - MIN_LIST_PX);
    expect(fractionAtPointer(5000, 0, 1440) * 1440).toBeCloseTo(MIN_READER_PX);
  });

  it("falls back to the default for an unmeasured container", () => {
    expect(fractionAtPointer(10, 0, 0)).toBe(DEFAULT_READER_FRACTION);
  });
});

describe("percentages", () => {
  it("reports the divider's position as the list's share", () => {
    expect(listPercent(DEFAULT_READER_FRACTION)).toBe(62);
    expect(listPercent(0.5)).toBe(50);
  });

  it("gives whole-number bounds inside the real range", () => {
    const { min, max } = percentBounds(1440);
    expect(min).toBe(Math.ceil((MIN_LIST_PX / 1440) * 100));
    expect(max).toBe(Math.floor(((1440 - MIN_READER_PX) / 1440) * 100));
    expect(min).toBeLessThan(listPercent(DEFAULT_READER_FRACTION));
    expect(max).toBeGreaterThan(listPercent(DEFAULT_READER_FRACTION));
  });

  it("writes a percentage for the CSS variable", () => {
    expect(splitCssValue(0.38)).toBe("38%");
    expect(splitCssValue(0.41237)).toBe("41.24%");
  });
});

describe("stepReaderFraction", () => {
  const W = 1440;

  it("moves the divider by 2%, or 10% with Shift", () => {
    expect(stepReaderFraction(0.4, "ArrowRight", false, W)).toBeCloseTo(0.4 - STEP);
    expect(stepReaderFraction(0.4, "ArrowLeft", false, W)).toBeCloseTo(0.4 + STEP);
    expect(stepReaderFraction(0.4, "ArrowRight", true, W)).toBeCloseTo(0.4 - BIG_STEP);
    expect(stepReaderFraction(0.4, "ArrowLeft", true, W)).toBeCloseTo(0.4 + BIG_STEP);
  });

  it("goes to the ends with Home and End", () => {
    const { min, max } = splitBounds(W);
    expect(stepReaderFraction(0.4, "Home", false, W)).toBe(max);
    expect(stepReaderFraction(0.4, "End", false, W)).toBe(min);
  });

  it("stops at the minimums", () => {
    const { min, max } = splitBounds(W);
    expect(stepReaderFraction(min, "ArrowRight", true, W)).toBe(min);
    expect(stepReaderFraction(max, "ArrowLeft", true, W)).toBe(max);
  });

  it("steps from where the divider is, not from an out-of-range saved value", () => {
    // Saved at 10%, shown at the reader's minimum: ArrowLeft widens it from there.
    const { min } = splitBounds(W);
    expect(stepReaderFraction(0.1, "ArrowLeft", false, W)).toBeCloseTo(min + STEP);
  });

  it("ignores every other key", () => {
    expect(stepReaderFraction(0.4, "ArrowUp", false, W)).toBeNull();
    expect(stepReaderFraction(0.4, "a", false, W)).toBeNull();
  });
});

describe("persistence", () => {
  it("round-trips a split", () => {
    const store = memory();
    saveReaderFraction(store, 0.45);
    expect(JSON.parse(store.data.get(READER_SPLIT_KEY) ?? "null")).toEqual({ reader: 0.45 });
    expect(loadReaderFraction(store)).toBe(0.45);
  });

  it("uses the app's key naming", () => {
    expect(READER_SPLIT_KEY).toBe("winnow.readerSplit.v1");
  });

  it("returns the default when nothing is saved", () => {
    expect(loadReaderFraction(memory())).toBe(DEFAULT_READER_FRACTION);
    expect(loadReaderFraction(null)).toBe(DEFAULT_READER_FRACTION);
  });

  it("does not clamp on load, so a split from a wide window comes back with it", () => {
    expect(loadReaderFraction(memory({ [READER_SPLIT_KEY]: JSON.stringify({ reader: 0.2 }) }))).toBe(0.2);
  });

  it("tolerates anything else in storage", () => {
    for (const raw of ["", "{", "0.4", "null", '"x"', '{"reader":"0.4"}', '{"reader":0}', '{"reader":1}', '{"reader":-2}']) {
      expect(loadReaderFraction(memory({ [READER_SPLIT_KEY]: raw })), raw).toBe(DEFAULT_READER_FRACTION);
    }
  });

  it("saves the default as no entry, so a reset leaves nothing behind", () => {
    const store = memory({ [READER_SPLIT_KEY]: JSON.stringify({ reader: 0.5 }) });
    saveReaderFraction(store, DEFAULT_READER_FRACTION);
    expect(store.data.has(READER_SPLIT_KEY)).toBe(false);
  });

  it("survives a storage that throws", () => {
    const broken: SplitStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadReaderFraction(broken)).toBe(DEFAULT_READER_FRACTION);
    expect(() => saveReaderFraction(broken, 0.5)).not.toThrow();
  });
});

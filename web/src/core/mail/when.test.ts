import { describe, expect, it } from "vitest";
import {
  LATE_AFTER_MS,
  customTimeProblem,
  dayDifference,
  formatWhen,
  fromLocalInputs,
  laterToday,
  nextWeek,
  thisWeekend,
  toLocalInputs,
  tomorrowMorning,
  wentLate,
  whenPresets,
} from "./when";

/** Local wall-clock instants, so the tests hold in any time zone. */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const parts = (ms: number) => {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};

// Tuesday 20 October 2026, 17:01.
const TUESDAY = at(2026, 10, 20, 17, 1);

describe("the presets", () => {
  it("puts Later today three hours on, rounded up to the half hour", () => {
    expect(parts(laterToday(TUESDAY)!)).toEqual([2026, 10, 20, 20, 30]);
    expect(parts(laterToday(at(2026, 10, 20, 14, 0))!)).toEqual([2026, 10, 20, 17, 0]);
    expect(parts(laterToday(at(2026, 10, 20, 9, 31))!)).toEqual([2026, 10, 20, 13, 0]);
  });

  it("offers no Later today once that would be tomorrow", () => {
    expect(laterToday(at(2026, 10, 20, 21, 0))).toBeNull();
    expect(laterToday(at(2026, 10, 20, 20, 45))).toBeNull();
  });

  it("puts Tomorrow at 9:00, on the clock even across a daylight-saving change", () => {
    expect(parts(tomorrowMorning(TUESDAY))).toEqual([2026, 10, 21, 9, 0]);
    // The last Sunday of October: the clocks go back in Europe.
    expect(parts(tomorrowMorning(at(2026, 10, 24, 22, 0)))).toEqual([2026, 10, 25, 9, 0]);
    expect(parts(tomorrowMorning(at(2026, 12, 31, 23, 0)))).toEqual([2027, 1, 1, 9, 0]);
  });

  it("puts This weekend on Saturday 9:00, and offers none at the weekend", () => {
    expect(parts(thisWeekend(TUESDAY)!)).toEqual([2026, 10, 24, 9, 0]);
    expect(thisWeekend(at(2026, 10, 24, 8, 0))).toBeNull();
    expect(thisWeekend(at(2026, 10, 25, 8, 0))).toBeNull();
  });

  it("puts Next week on the coming Monday at 9:00", () => {
    expect(parts(nextWeek(TUESDAY))).toEqual([2026, 10, 26, 9, 0]);
    expect(parts(nextWeek(at(2026, 10, 19, 8, 0)))).toEqual([2026, 10, 26, 9, 0]);
    expect(parts(nextWeek(at(2026, 10, 25, 8, 0)))).toEqual([2026, 10, 26, 9, 0]);
  });

  it("lists them in order, each in the future, and never the same instant twice", () => {
    const presets = whenPresets(TUESDAY);
    expect(presets.map((p) => p.id)).toEqual(["laterToday", "tomorrow", "weekend", "nextWeek"]);
    for (const preset of presets) expect(preset.at).toBeGreaterThan(TUESDAY);
    // On a Friday, Saturday is tomorrow: one entry, not two at the same time.
    const friday = whenPresets(at(2026, 10, 23, 10, 0));
    expect(friday.map((p) => p.id)).toEqual(["laterToday", "tomorrow", "nextWeek"]);
    // Late on a Saturday: no Later today, no This weekend.
    expect(whenPresets(at(2026, 10, 24, 22, 0)).map((p) => p.id)).toEqual(["tomorrow", "nextWeek"]);
  });
});

describe("saying a time back", () => {
  it("names today, tomorrow and yesterday, the weekday within the week, and the date beyond", () => {
    expect(formatWhen(at(2026, 10, 20, 20, 30), TUESDAY)).toMatch(/^Today, /);
    expect(formatWhen(at(2026, 10, 21, 9, 0), TUESDAY)).toMatch(/^Tomorrow, /);
    expect(formatWhen(at(2026, 10, 19, 9, 0), TUESDAY)).toMatch(/^Yesterday, /);
    expect(formatWhen(at(2026, 10, 24, 9, 0), TUESDAY)).toMatch(/^Sat/);
    expect(formatWhen(at(2026, 11, 24, 9, 0), TUESDAY)).toMatch(/24/);
    expect(formatWhen(at(2027, 1, 4, 9, 0), TUESDAY)).toMatch(/2027/);
  });

  it("counts calendar days, not 24-hour blocks", () => {
    expect(dayDifference(at(2026, 10, 20, 23, 59), at(2026, 10, 21, 0, 1))).toBe(1);
    expect(dayDifference(at(2026, 10, 24, 12, 0), at(2026, 10, 26, 12, 0))).toBe(2);
  });
});

describe("the date and time fields", () => {
  it("round-trips an instant through the inputs' local strings", () => {
    const inputs = toLocalInputs(at(2026, 3, 7, 8, 5));
    expect(inputs).toEqual({ date: "2026-03-07", time: "08:05" });
    expect(fromLocalInputs(inputs.date, inputs.time)).toBe(at(2026, 3, 7, 8, 5));
  });

  it("refuses what is not a date and time", () => {
    expect(fromLocalInputs("2026-02-31", "09:00")).toBeNull();
    expect(fromLocalInputs("", "09:00")).toBeNull();
    expect(fromLocalInputs("2026-02-01", "25:00")).toBeNull();
  });

  it("asks for a time in the future", () => {
    expect(customTimeProblem(null, TUESDAY)).toMatch(/Pick a date/);
    expect(customTimeProblem(TUESDAY - 1, TUESDAY)).toMatch(/future/);
    expect(customTimeProblem(TUESDAY + 30_000, TUESDAY)).toMatch(/future/);
    expect(customTimeProblem(TUESDAY + 3_600_000, TUESDAY)).toBeNull();
  });
});

describe("late", () => {
  it("is anything run more than the grace after it was due", () => {
    expect(wentLate(TUESDAY, TUESDAY + 1000)).toBe(false);
    expect(wentLate(TUESDAY, TUESDAY + LATE_AFTER_MS + 1)).toBe(true);
  });
});

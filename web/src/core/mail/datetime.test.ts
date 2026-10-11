/**
 * Time formatting and day bucketing.
 *
 * The tests build `now` from local calendar fields rather than `Date.now()`,
 * because `dayBucket` compares *local* days — a test in a week with a DST shift
 * would otherwise fail twice a year for the right reason.
 */

import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  dayBucket,
  daySections,
  formatRelative,
  formatRowTime,
} from "./datetime";

/** Local noon, so no test straddles a midnight boundary. */
function local(daysAgo: number, hours = 12): number {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, 0, 0, 0);
  return date.getTime() - daysAgo * DAY_MS;
}

function rows(...daysAgo: number[]): { id: number; receivedAt: number }[] {
  return daysAgo.map((days, i) => ({ id: i + 1, receivedAt: local(days) }));
}

/** Sections read their date through a selector, as the thread rows require. */
type Row = { id: number; receivedAt: number };
const receivedAt = (row: Row) => row.receivedAt;
const sections = (list: Row[], byDate: boolean) => daySections(list, local(0), receivedAt, byDate);

describe("dayBucket", () => {
  it("calls the future today", () => {
    // A clock skewed ahead — or a server that stamps in a timezone ahead of the
    // reader's — must not push this morning's mail into "Yesterday".
    const now = local(0, 12);
    expect(dayBucket(local(0, 13), now)).toBe("today");
    expect(dayBucket(local(0, 1), now)).toBe("today");
  });

  it("separates yesterday from the rest of the week", () => {
    const now = local(0, 12);
    expect(dayBucket(local(1), now)).toBe("yesterday");
    expect(dayBucket(local(2), now)).toBe("week");
    expect(dayBucket(local(6), now)).toBe("week");
  });

  it("puts anything a week or more old in earlier", () => {
    const now = local(0, 12);
    expect(dayBucket(local(7), now)).toBe("earlier");
    expect(dayBucket(local(400), now)).toBe("earlier");
  });

  it("counts whole local days, so a short DST day is still one day", () => {
    // 23-hour and 25-hour days exist. Dividing the instant difference by 24h
    // rounds a message across a spring-forward to the wrong day; re-based calendar
    // fields do not.
    const spring = new Date(2026, 2, 8, 12, 0, 0, 0).getTime(); // 8 Mar 2026, US DST start
    const nightBefore = new Date(2026, 2, 8, 1, 30, 0, 0).getTime();
    expect(spring - nightBefore).toBeLessThan(DAY_MS);
    expect(dayBucket(nightBefore, spring)).toBe("today");
  });
});

describe("daySections", () => {
  it("labels each run when the list is chronological", () => {
    const found = sections(rows(0, 0, 1, 3), true);
    expect(found.map((s) => s.label)).toEqual(["Today", "Yesterday", "This week"]);
    expect(found.map((s) => s.rows.length)).toEqual([2, 1, 1]);
  });

  it("gives every section a distinct key", () => {
    // Keyed on the bucket name this was `today`, `week`, `today` — three React
    // children two of which shared a key.
    const found = sections(rows(0, 3, 0, 3, 0), true);
    expect(new Set(found.map((s) => s.key)).size).toBe(found.length);
  });

  it("merges adjacent runs and does not re-open a closed bucket", () => {
    // A filtered list that skips a day must not grow a second "This week".
    const found = sections(rows(0, 1, 3, 4), true);
    expect(found.map((s) => s.label)).toEqual(["Today", "Yesterday", "This week"]);
    expect(found[2].rows.map((r) => r.row.id)).toEqual([3, 4]);
  });

  it("returns one unlabelled section when the list is not chronological", () => {
    // Sorting by score or sender interleaves the days, so the headers would be
    // adjacency claims that cannot be true — `Today / This week / Today` — and
    // every repeat would collide on a key.
    const found = sections(rows(0, 3, 0, 40, 0), false);
    expect(found).toHaveLength(1);
    expect(found[0].label).toBeNull();
    expect(found[0].rows.map((r) => r.row.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("still buckets every row when there is no header", () => {
    // The header is gone, not the information: each row keeps its own bucket, and
    // that is what chooses between a clock time and a date in the row's corner.
    const found = sections(rows(0, 3, 40), false);
    expect(found[0].rows.map((r) => r.bucket)).toEqual(["today", "week", "earlier"]);
  });

  it("keeps an interleaved list unique even if the caller groups it anyway", () => {
    const found = sections(rows(0, 3, 0, 3, 0), true);
    expect(found).toHaveLength(5);
    expect(new Set(found.map((s) => s.key)).size).toBe(5);
  });

  it("reads the date through the selector it was given", () => {
    // The list's rows are threads, so the section's day is the *representative*
    // message's — the one the row prints — and not the newest in the thread.
    type Thread = { key: string; receivedAt: number };
    const threads: Thread[] = [
      { key: "t2", receivedAt: local(30) },
      { key: "t1", receivedAt: local(0) },
    ];
    const found = daySections(threads, local(0), (row) => row.receivedAt, true);
    expect(found.map((s) => s.label)).toEqual(["Earlier", "Today"]);
  });

  it("has no sections for no rows", () => {
    expect(sections([], true)).toEqual([]);
    expect(sections([], false)).toEqual([]);
  });
});

/**
 * What a `day`-format timestamp looks like *in this runtime's locale*.
 *
 * Built with the same `Intl` call the source uses, rather than written out as a
 * regex. Three separate assumptions were baked into a literal `/^[A-Z][a-z]{2} \d{1,2}$/`:
 * the month comes before the day (US — `en-GB` writes `4 Oct`), it is exactly
 * three letters (`en-GB` abbreviates September to `Sept`), and the month starts
 * with a capital. All three are true in some locale and false in others, so the
 * test asserted the *machine's locale* rather than the formatter's behaviour, and
 * passed or failed depending on who ran it. Deriving the expectation removes the
 * assumption without weakening the check: a clock time still fails to match, and a
 * row that wrongly printed a date for today still fails.
 */
function localeDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(ms);
}

/** A clock time in any locale, as `hour`/`minute` with no seconds. */
const CLOCK = /^\d{1,2}[:.]\d{2}/;

describe("formatRowTime", () => {
  it("shows a clock time for today and yesterday, a date beyond", () => {
    // Inside Today "10:42" is the whole answer; repeating it down a section of
    // last month says nothing, which is why the bucket decides.
    const now = local(0, 23);
    expect(formatRowTime(local(0, 9), dayBucket(local(0, 9), now))).toMatch(CLOCK);
    expect(formatRowTime(local(1, 9), dayBucket(local(1, 9), now))).toMatch(CLOCK);

    const twentyDaysAgo = local(20);
    expect(formatRowTime(twentyDaysAgo, dayBucket(twentyDaysAgo, now))).toBe(
      localeDate(twentyDaysAgo),
    );
  });

  it("takes the timestamp's format from the bucket it is given", () => {
    // The two arguments are independent on purpose: a row's timestamp format is
    // chosen by its bucket, so a caller that guessed the bucket wrong gets the
    // other format rather than a crash.
    const todayButEarlierBucket = local(0, 9);
    expect(formatRowTime(todayButEarlierBucket, "earlier")).toBe(
      localeDate(todayButEarlierBucket),
    );
  });
});

describe("formatRelative", () => {
  it("collapses anything under a minute to 'just now'", () => {
    const now = local(0, 12);
    expect(formatRelative(now, now)).toBe("just now");
    expect(formatRelative(now - 44_000, now)).toBe("just now");
  });

  it("steps up through minutes, hours and days", () => {
    const now = local(0, 12);
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelative(now - 2 * DAY_MS, now)).toBe("2d ago");
  });

  it("falls back to a date past a week", () => {
    // Same locale point as `localeDate` above: the fallback is a `day`-format date,
    // and which month abbreviations exist is the runtime's business, not a test's.
    const now = local(0, 12);
    const monthAgo = now - 30 * DAY_MS;
    expect(formatRelative(monthAgo, now)).toBe(localeDate(monthAgo));
  });
});

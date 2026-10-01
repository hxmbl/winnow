/**
 * Time, formatted.
 *
 * Two questions get answered, and they need different strings:
 *
 *   - `formatRowTime`  — "when did this land?" while scanning a list. The
 *     useful answer depends on how far back you are: inside Today a clock time
 *     is all you need, but repeating "10:42 AM" down a section of last month
 *     says nothing. So the *day bucket* decides, and the section header is the
 *     only thing that has to reason about dates.
 *   - `formatFullTime` — the same, unambiguously, in the reader.
 *
 * Everything is built from calendar fields rather than by dividing local
 * midnights, so a daylight-saving shift between two dates cannot round the
 * difference to the wrong whole day. And `now` is always a parameter: the demo
 * seed passes its own reference instant, and the sync engine passes the real
 * clock, so neither depends on a hidden `Date.now()`.
 */

export type DayBucket = "today" | "yesterday" | "week" | "earlier";

const DAY_LABELS: Record<DayBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  earlier: "Earlier",
};

export const DAY_MS = 86_400_000;

type FormatterKey = "time" | "day" | "full" | "list" | "attribution";

const FORMAT_OPTS: Record<FormatterKey, Intl.DateTimeFormatOptions> = {
  time: { hour: "numeric", minute: "2-digit" },
  day: { month: "short", day: "numeric" },
  full: {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
  // The reader header: full date, so it is unambiguous a week later.
  list: { dateStyle: "medium", timeStyle: "short" },
  // The reply attribution, which should match the reader header exactly.
  attribution: { dateStyle: "medium", timeStyle: "short" },
};

/**
 * `Intl.DateTimeFormat` is expensive to construct — roughly an order of
 * magnitude more than to use — and these are called per list row per render.
 * One instance per format, for the session.
 */
const formatters = new Map<FormatterKey, Intl.DateTimeFormat>();

function formatterFor(key: FormatterKey): Intl.DateTimeFormat {
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, FORMAT_OPTS[key]);
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * Formatting is a pure function of the timestamp, so a list re-rendering on
 * hover reuses every string. Capped, and cleared wholesale rather than
 * evicted one-by-one: at this size a full rebuild is cheaper than the bookkeeping.
 */
const cache = new Map<string, string>();
const CACHE_LIMIT = 4096;

function memo(key: string, make: () => string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const out = make();
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, out);
  return out;
}

/** The right-hand column of a list row, given its section. */
export function formatRowTime(receivedAtMs: number, bucket: DayBucket): string {
  const dated = bucket === "week" || bucket === "earlier";
  return memo(`${dated ? "d" : "t"}${receivedAtMs}`, () =>
    formatterFor(dated ? "day" : "time").format(receivedAtMs),
  );
}

/** The reader header. */
export function formatFullTime(receivedAtMs: number): string {
  return memo(`f${receivedAtMs}`, () => formatterFor("full").format(receivedAtMs));
}

/**
 * The reader's absolute timestamp, and the reply attribution.
 *
 * The Swift implementation formatted this with `dateStyle: .medium` and
 * `timeStyle: .short`, which is the same thing — the attribution line is
 * supposed to read like the header of the message it quotes.
 */
export function formatListTime(receivedAtMs: number): string {
  return memo(`l${receivedAtMs}`, () => formatterFor("list").format(receivedAtMs));
}

export { formatterFor as formatAbsolute };

/**
 * Whole local calendar days between two instants.
 *
 * Built from the date fields and re-based on UTC, so a 23- or 25-hour DST day
 * still counts as exactly one day. Dividing by `DAY_MS` would drift by an hour
 * twice a year and mislabel a message as "Yesterday".
 */
function dayIndex(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

/** Which section a timestamp belongs to, relative to `now`. */
export function dayBucket(receivedAt: number, now: number): DayBucket {
  const days = dayIndex(now) - dayIndex(receivedAt);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "earlier";
}

export function dayLabel(bucket: DayBucket): string {
  return DAY_LABELS[bucket];
}

export type DayGroup<T> = {
  bucket: DayBucket;
  label: string;
  rows: T[];
};

/**
 * Collapse a date-sorted list into labelled runs.
 *
 * Consecutive rows sharing a bucket merge, so a filtered list that skips a day
 * never shows an empty section header.
 */
export function groupByDay<T extends { receivedAt: number }>(
  rows: readonly T[],
  now: number,
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const row of rows) {
    const bucket = dayBucket(row.receivedAt, now);
    const last = groups[groups.length - 1];
    if (last && last.bucket === bucket) last.rows.push(row);
    else groups.push({ bucket, label: DAY_LABELS[bucket], rows: [row] });
  }
  return groups;
}

/** A short "3 days ago"-style string, for the sync status line. */
export function formatRelative(fromMs: number, nowMs: number): string {
  const seconds = Math.round((nowMs - fromMs) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return memo(`r${fromMs}`, () => formatterFor("day").format(fromMs));
}

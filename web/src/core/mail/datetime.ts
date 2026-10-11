/**
 * Time, formatted.
 *
 * `formatRowTime` answers "when did this land?" for a list row: a clock time
 * inside Today, a date beyond, decided by the day bucket. `formatFullTime` is
 * the same unambiguously, in the reader.
 *
 * Days are counted from calendar fields rather than by dividing local midnights,
 * so a DST shift cannot round the difference to the wrong day. `now` is always a
 * parameter, never a hidden `Date.now()`.
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
 * magnitude more than to use — and these run per list row per render. One
 * instance per format, for the session.
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
 * hover reuses every string. Cleared wholesale rather than evicted one-by-one:
 * at this size a full rebuild is cheaper than the bookkeeping.
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
 * The attribution should read like the header of the message it quotes.
 */
export function formatListTime(receivedAtMs: number): string {
  return memo(`l${receivedAtMs}`, () => formatterFor("list").format(receivedAtMs));
}

/**
 * Whole local calendar days between two instants.
 *
 * Re-based on UTC, so a 23- or 25-hour DST day still counts as exactly one day;
 * dividing by `DAY_MS` would drift by an hour twice a year and mislabel a message
 * as "Yesterday".
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

/** A row paired with the day bucket its timestamp falls in. */
export type Dated<T> = { row: T; bucket: DayBucket };

export type DaySection<T> = {
  /**
   * Unique within one result.
   *
   * Keying on the *bucket name* is a bug rather than a shortcut: sections are runs
   * of adjacent rows, so any list that is not chronological repeats a bucket and
   * every repeat collides.
   */
  key: string;
  /**
   * The header text, or `null` when there is no header.
   *
   * A day header claims adjacency — "everything above this arrived today" — which
   * only a date-sorted list can assert. Sorted by score or sender the days
   * interleave, so a non-chronological list gets one unlabelled section; the rows
   * still carry their own bucket, which is what `formatRowTime` needs to choose
   * between "10:42" and "Mar 3".
   */
  label: string | null;
  rows: Dated<T>[];
};

/**
 * Split a displayed list into labelled day runs — or into one unlabelled run.
 *
 * The date comes from `receivedAt` rather than from a field, because the rows are
 * *threads*: the section labels the representative message's date, the one the
 * row itself prints.
 *
 * `byDate` is required rather than defaulted: it is the one fact this function
 * cannot infer, and a default of `true` would turn a chronological-by-accident
 * caller back into the bug this exists to prevent.
 *
 * Consecutive rows sharing a bucket merge, so a filtered list that skips a day
 * never shows an empty section header.
 */
export function daySections<T>(
  rows: readonly T[],
  now: number,
  receivedAt: (row: T) => number,
  byDate: boolean,
): DaySection<T>[] {
  const dated: Dated<T>[] = rows.map((row) => ({ row, bucket: dayBucket(receivedAt(row), now) }));
  // No rows, no section. Not a section with no rows: an empty `<section>` around
  // an empty `role="list"` is a landmark a screen reader still announces.
  if (dated.length === 0) return [];
  if (!byDate) return [{ key: "all", label: null, rows: dated }];

  const sections: DaySection<T>[] = [];
  for (const entry of dated) {
    const last = sections[sections.length - 1];
    // Every row in `last` shares its first row's bucket — that is what merging on
    // it means — so the first row is the section's bucket.
    if (last && last.rows[0].bucket === entry.bucket) last.rows.push(entry);
    else {
      sections.push({
        key: `day-${sections.length}`,
        label: DAY_LABELS[entry.bucket],
        rows: [entry],
      });
    }
  }
  return sections;
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

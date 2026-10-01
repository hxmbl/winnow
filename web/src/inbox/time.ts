/**
 * Every timestamp string in the app, plus the day buckets the list groups by.
 *
 * Two formats, each answering a different question:
 *   - `formatRowTime`  — "when did this land?" while scanning the list.
 *   - `formatFullTime` — the same, unambiguously, while reading one message.
 *
 * `formatRowTime` takes the row's day bucket because the useful string depends
 * on it: inside "Today" a clock time is all you need, but repeating "10:42 AM"
 * down an "Earlier" section tells you nothing. So the bucket decides, and the
 * section header is the only thing that has to know about days.
 */

/**
 * Constructing an Intl.DateTimeFormat is far costlier than using one — build
 * each format once per session.
 */
type FormatterKey = "time" | "day" | "full";

const FORMAT_OPTS: Record<FormatterKey, Intl.DateTimeFormatOptions> = {
  // Row right-hand column, inside a dated section.
  time: { hour: "numeric", minute: "2-digit" },
  // Row right-hand column, in a section that is already several days deep.
  day: { month: "short", day: "numeric" },
  // Reader header, where nothing else on screen supplies the context.
  full: {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
};

const formatters = new Map<FormatterKey, Intl.DateTimeFormat>();

function getFormatter(key: FormatterKey): Intl.DateTimeFormat {
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, FORMAT_OPTS[key]);
    formatters.set(key, f);
  }
  return f;
}

/** Formatting is a pure function of the timestamp, so identical rows reuse the same string. */
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

export function formatRowTime(receivedAtMs: number, bucket: DayBucket): string {
  const dated = bucket === "week" || bucket === "earlier";
  return memo(`${dated ? "d" : "t"}${receivedAtMs}`, () =>
    getFormatter(dated ? "day" : "time").format(receivedAtMs),
  );
}

export function formatFullTime(receivedAtMs: number): string {
  return memo(`f${receivedAtMs}`, () => getFormatter("full").format(receivedAtMs));
}

// ── Day buckets ─────────────────────────────────────────────────

export type DayBucket = "today" | "yesterday" | "week" | "earlier";

const DAY_LABELS: Record<DayBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  earlier: "Earlier",
};

const DAY_MS = 86_400_000;

/**
 * Days since the local calendar date of `ms`, as a plain number.
 *
 * Built from the calendar fields rather than by dividing local midnights, so a
 * daylight-saving shift between the two dates can't round the difference to the
 * wrong whole day.
 */
function dayIndex(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
}

/**
 * Which section a timestamp belongs to, relative to `now`.
 *
 * `now` is a parameter rather than a `Date.now()` call so the seeded mock can
 * pass its own reference instant — otherwise every row lands in "Earlier" the
 * moment the real clock drifts past the fixture.
 */
export function dayBucket(receivedAt: number, now: number): DayBucket {
  const days = dayIndex(now) - dayIndex(receivedAt);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "earlier";
}

export type DayGroup<T> = {
  bucket: DayBucket;
  label: string;
  emails: T[];
};

/**
 * Collapses a date-sorted list into labelled runs. Consecutive rows that share
 * a bucket are merged, so a filtered list that skips a day never shows an
 * empty section.
 */
export function groupByDay<T extends { receivedAt: number }>(
  emails: T[],
  now: number,
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const email of emails) {
    const bucket = dayBucket(email.receivedAt, now);
    const label = DAY_LABELS[bucket];
    const last = groups[groups.length - 1];
    if (last && last.bucket === bucket) last.emails.push(email);
    else groups.push({ bucket, label, emails: [email] });
  }
  return groups;
}
/**
 * "When": the times snooze and send later offer, worked out in the user's local time,
 * and how a chosen time is said back.
 *
 * Shared by both features so the two pickers cannot disagree about what "Tomorrow" is.
 * Every preset is built with the local `Date` setters, never by adding multiples of 24
 * hours, so a day with a daylight-saving change still lands on 9:00 on the clock.
 *
 * The presets, after Gmail's:
 *
 *   - **Later today**: three hours from now, rounded up to the next half hour. Not
 *     offered when that is no longer today (late evening), where the name would lie.
 *   - **Tomorrow**: 9:00 tomorrow.
 *   - **This weekend**: Saturday 9:00. Not offered on Saturday or Sunday, which already
 *     are the weekend.
 *   - **Next week**: Monday 9:00 of the coming week (a week today on a Monday).
 *
 * Pure: `now` is always handed in.
 */

import type { Millis } from "../model/email";

export type WhenPresetId = "laterToday" | "tomorrow" | "weekend" | "nextWeek";

export type WhenPreset = {
  id: WhenPresetId;
  /** What the menu says: "Later today". */
  label: string;
  /** The instant it means. */
  at: Millis;
  /** The instant as the menu prints it beside the label: "18:00", "Sat 09:00". */
  detail: string;
};

/** The morning hour the day presets use. */
export const MORNING_HOUR = 9;

/** How far "Later today" looks ahead. */
export const LATER_TODAY_MS = 3 * 60 * 60 * 1000;

/** "Later today" is rounded up to the next multiple of this. */
export const ROUND_TO_MS = 30 * 60 * 1000;

/**
 * How long after its time a scheduled send or a wake still counts as on time. Past
 * this, the app was not running at the time and says the message went late.
 */
export const LATE_AFTER_MS = 2 * 60 * 1000;

/** The earliest a custom time may be: a minute from now, so it is not already due. */
export const MIN_LEAD_MS = 60 * 1000;

function atMorning(date: Date): Millis {
  date.setHours(MORNING_HOUR, 0, 0, 0);
  return date.getTime();
}

function sameDay(a: Millis, b: Millis): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** Three hours on, rounded up to the half hour; `null` when that is tomorrow already. */
export function laterToday(now: Millis): Millis | null {
  const date = new Date(now + LATER_TODAY_MS);
  const step = ROUND_TO_MS / 60_000;
  const exact = date.getSeconds() === 0 && date.getMilliseconds() === 0 && date.getMinutes() % step === 0;
  date.setSeconds(0, 0);
  // Local minutes, not epoch arithmetic: a zone at +5:45 rounds to its own half hours.
  if (!exact) date.setMinutes(Math.floor(date.getMinutes() / step) * step + step);
  const at = date.getTime();
  return sameDay(at, now) ? at : null;
}

/** 9:00 tomorrow. */
export function tomorrowMorning(now: Millis): Millis {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  return atMorning(date);
}

/** Saturday 9:00 of this week, or `null` on Saturday and Sunday. */
export function thisWeekend(now: Millis): Millis | null {
  const date = new Date(now);
  const day = date.getDay(); // 0 Sunday … 6 Saturday
  if (day === 0 || day === 6) return null;
  date.setDate(date.getDate() + (6 - day));
  return atMorning(date);
}

/** Monday 9:00 of next week (a week today when today is Monday). */
export function nextWeek(now: Millis): Millis {
  const date = new Date(now);
  const day = date.getDay();
  const ahead = (8 - day) % 7 || 7;
  date.setDate(date.getDate() + ahead);
  return atMorning(date);
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const yearFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** The clock time alone: "09:00" (or "09:00 AM", by locale). */
export function formatClock(at: Millis): string {
  return timeFormat.format(at);
}

/**
 * A chosen time said back, as short as it can be without being ambiguous: "Today,
 * 18:00", "Tomorrow, 09:00", "Sat, 09:00" within the coming week, "24 Oct, 09:00"
 * further out, with the year when it is not this one. Past times read the same way
 * ("Yesterday, …"), for a send that went late.
 */
export function formatWhen(at: Millis, now: Millis): string {
  const clock = formatClock(at);
  const days = dayDifference(now, at);
  if (days === 0) return `Today, ${clock}`;
  if (days === 1) return `Tomorrow, ${clock}`;
  if (days === -1) return `Yesterday, ${clock}`;
  if (days > 1 && days < 7) return `${weekdayFormat.format(at)}, ${clock}`;
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return `${(sameYear ? dayFormat : yearFormat).format(at)}, ${clock}`;
}

/** Whole local calendar days from `from` to `to` (negative for the past). */
export function dayDifference(from: Millis, to: Millis): number {
  const a = new Date(from);
  const b = new Date(to);
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / 86_400_000);
}

/** The presets on offer now, in menu order. */
export function whenPresets(now: Millis): WhenPreset[] {
  const out: WhenPreset[] = [];
  const later = laterToday(now);
  if (later !== null) out.push({ id: "laterToday", label: "Later today", at: later, detail: formatClock(later) });
  const tomorrow = tomorrowMorning(now);
  out.push({ id: "tomorrow", label: "Tomorrow", at: tomorrow, detail: `${weekdayFormat.format(tomorrow)} ${formatClock(tomorrow)}` });
  const weekend = thisWeekend(now);
  // Saturday is tomorrow on a Friday: the same instant twice reads as a mistake.
  if (weekend !== null && weekend !== tomorrow) {
    out.push({ id: "weekend", label: "This weekend", at: weekend, detail: `${weekdayFormat.format(weekend)} ${formatClock(weekend)}` });
  }
  const week = nextWeek(now);
  out.push({ id: "nextWeek", label: "Next week", at: week, detail: `${weekdayFormat.format(week)} ${formatClock(week)}` });
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An instant as the values of `<input type="date">` and `<input type="time">`. */
export function toLocalInputs(at: Millis): { date: string; time: string } {
  const d = new Date(at);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** `YYYY-MM-DD` and `HH:MM` in local time → an instant, or `null` if either is not one. */
export function fromLocalInputs(date: string, time: string): Millis | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!dm || !tm) return null;
  const [year, month, day] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [hour, minute] = [Number(tm[1]), Number(tm[2])];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const at = new Date(year, month - 1, day, hour, minute, 0, 0);
  // 31 February rolls into March: not a date the user picked.
  if (at.getMonth() !== month - 1 || at.getDate() !== day) return null;
  return at.getTime();
}

/** Why a picked time cannot be used, or `null` when it can. */
export function customTimeProblem(at: Millis | null, now: Millis): string | null {
  if (at === null) return "Pick a date and a time.";
  if (at < now + MIN_LEAD_MS) return "Pick a time in the future.";
  return null;
}

/** Whether something due at `due` and run at `ran` went late (the app was not running). */
export function wentLate(due: Millis, ran: Millis): boolean {
  return ran - due > LATE_AFTER_MS;
}

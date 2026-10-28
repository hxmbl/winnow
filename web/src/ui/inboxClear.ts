/**
 * The empty list, when it is good news.
 *
 * An empty list means one of two different things, and they deserve different screens:
 *
 *   - **Clear.** The Inbox has nothing in it — or nothing but the junk Winnow holds back,
 *     which is the same news: nothing left that needs you — or the one smart filter you were working
 *     through (Important, Shipping, …) has nothing left. That is the moment Winnow is for,
 *     so it gets the calm illustration, a line that follows the time of day, and — when
 *     *you* cleared the last item, rather than opening onto an empty view — one gentle
 *     motion and a haptic tap on a phone.
 *   - **Quiet.** An empty folder (Sent, Archive, Trash, Spam, Drafts), or a filter that
 *     matches nothing outside the Inbox or alongside other filters. Nothing to celebrate:
 *     a small line and the existing remedy button.
 *
 * Search is neither: it keeps the plain remedy screen in `MessageList`. Junk held back
 * outside the Inbox does too.
 *
 * Everything here is pure; `components/InboxClear.tsx` draws it and
 * `useClearCelebration.ts` decides when the motion plays.
 */

import type { EmptyReason } from "../core/classify/pipeline";
import { MAILBOX_LABEL, type Mailbox } from "../core/model/email";
import { FILTER_LABELS, filterKey, type FilterId } from "../core/model/signals";

/** What the list is showing, as far as an empty state cares. */
export type EmptyContext = {
  mailbox: Mailbox;
  filters: readonly FilterId[];
};

export type EmptyKind =
  | { kind: "clear"; scope: "inbox"; heldBack?: boolean }
  | { kind: "clear"; scope: "filter"; label: string }
  | { kind: "quiet"; scope: "folder"; label: string }
  | { kind: "quiet"; scope: "filter" };

/**
 * Which empty state the list shows, or `null` for the remedy screens (search, junk held
 * back) that `MessageList` keeps for itself.
 */
export function emptyKindFor(reason: EmptyReason, context: EmptyContext | undefined): EmptyKind | null {
  if (!context) return null;
  // Everything left in the Inbox looks like junk: nothing needs attention, which is the
  // clear state, with the held-back mail one quiet link away.
  if (reason === "noSignal" && context.mailbox === "inbox" && context.filters.length === 0) {
    return { kind: "clear", scope: "inbox", heldBack: true };
  }
  if (reason === "mailbox") {
    if (context.mailbox === "inbox") return { kind: "clear", scope: "inbox" };
    return { kind: "quiet", scope: "folder", label: MAILBOX_LABEL[context.mailbox] };
  }
  if (reason === "filters") {
    const only = context.filters.length === 1 ? context.filters[0] : undefined;
    if (context.mailbox === "inbox" && only?.kind === "builtin") {
      return { kind: "clear", scope: "filter", label: FILTER_LABELS[only.id] };
    }
    return { kind: "quiet", scope: "filter" };
  }
  return null;
}

/** A stable name for "this view", so a celebration only follows a change inside one. */
export function viewKey(context: EmptyContext | undefined): string {
  if (!context) return "";
  return [context.mailbox, ...context.filters.map(filterKey).sort()].join("|");
}

export type DayPart = "morning" | "afternoon" | "evening" | "night";

/** The part of the day for a local hour, 0–23. */
export function dayPart(hour: number): DayPart {
  const h = ((Math.trunc(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 22) return "evening";
  return "night";
}

/**
 * Lines for a clear Inbox, by part of the day. Short, unexcited and true: Winnow has
 * read nothing for you, so none of them claim you are "all caught up" on anything but
 * the list in front of you.
 */
export const CLEAR_LINES: Record<DayPart, readonly string[]> = {
  morning: ["A clear start to the day.", "Nothing waiting.", "Inbox clear before the day gets going."],
  afternoon: ["Clear for the afternoon.", "Nothing needs you right now.", "All quiet."],
  evening: ["Clear for the evening.", "Nothing left for today.", "The inbox can wait until tomorrow."],
  night: ["All clear.", "Nothing here that can't wait till morning.", "Quiet inbox."],
};

/** A day number in local time, so the line holds still all day and changes tomorrow. */
function localDay(now: Date): number {
  return Math.floor((now.getTime() - now.getTimezoneOffset() * 60_000) / 86_400_000);
}

/** The headline for a clear state at `now`. */
export function clearHeadline(kind: Extract<EmptyKind, { kind: "clear" }>, now: Date): string {
  if (kind.scope === "filter") return `Nothing left in ${kind.label}.`;
  const lines = CLEAR_LINES[dayPart(now.getHours())];
  return lines[localDay(now) % lines.length]!;
}

/** The smaller line under the headline. */
export function clearDetail(kind: Extract<EmptyKind, { kind: "clear" }>): string {
  if (kind.scope === "filter") return "Everything that filter flagged has been dealt with.";
  return kind.heldBack
    ? "Nothing left that needs you. Winnow is holding back what looks like junk."
    : "Your Inbox is clear. New mail will show up here.";
}

/** The quiet state's one line. */
export function quietLine(kind: Extract<EmptyKind, { kind: "quiet" }>, override?: string): string {
  if (override) return override;
  return kind.scope === "folder" ? `${kind.label} is empty.` : "Nothing matches those filters.";
}

/**
 * Whether this render is the moment the last item was cleared: the same view had rows
 * a moment ago and has none now. Opening an empty view, switching to one, or the first
 * render are not that moment.
 */
export function justCleared(
  previous: { key: string; count: number } | null,
  current: { key: string; count: number },
): boolean {
  return previous !== null && previous.key === current.key && previous.count > 0 && current.count === 0;
}

/** A short, soft double tap. Phones that ignore `vibrate` lose nothing. */
export const CLEAR_HAPTIC: readonly number[] = [14, 70, 22];

/** How long the celebration's motion runs, in ms. The class is dropped after it. */
export const CELEBRATION_MS = 1600;

/**
 * The "Smart Score" sort.
 *
 * A single 0–100 number per message, used only for ordering. It is
 * deliberately *not* the importance score: importance is the learnable engine
 * whose weights the user tunes, and if sorting were driven by it, then every
 * slider drag would silently reorder the inbox. This one is fixed, so the sort
 * stays stable while the tuning moves underneath it.
 *
 * The two do share `senderRankBonus`, so they agree about *who* matters even
 * though they disagree about *how much* each signal is worth.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Classification/Scoring.swift`.
 */

import type { Email } from "../model/email";
import type { EmailSignals } from "../model/signals";
import { trashBiasFor, type UserProfile } from "../model/profile";
import { compile } from "./text";
import { senderRankBonus } from "./classify";

/**
 * Intent tells and what each contributes.
 *
 * Kept separate from the `heuristics` keyword tables on purpose. Those drive
 * the learnable importance engine; these fix the sort. They overlap in spirit
 * but not in tokens — merging them would make the sort wobble whenever a
 * weight changed.
 */
const INTENT_PATTERNS: readonly { pattern: RegExp; weight: number }[] = [
  { pattern: compile("\\b(?:security|password|2fa|breach|unauthorized|suspicious|login attempt)\\b"), weight: 15 },
  { pattern: compile("\\b(?:urgent|asap|deadline|time sensitive|action required|critical)\\b"), weight: 12 },
  { pattern: compile("\\b(?:invoice|receipt|payment|billing|statement)\\b"), weight: 8 },
  { pattern: compile("\\b(?:confirm|verify|appointment|reminder)\\b"), weight: 6 },
  { pattern: compile("\\b(?:sale|discount|promo(?:tion)?|flash sale|\\d+%\\s*off)\\b"), weight: -8 },
  { pattern: compile("\\b(?:unsubscribe|newsletter|weekly digest)\\b"), weight: -10 },
  // Bare "due" would fire on "due to arrive tomorrow", which is timing rather
  // than a missed bill, so only the overdue phrasings count.
  { pattern: compile("\\b(?:past due|overdue|late fee|amount due)\\b"), weight: 10 },
] as const;

/** The largest recency nudge the sort can hand out. */
export const MAX_RECENCY_BONUS = 3;

/**
 * The age window a score is computed against: the span of the messages being
 * scored.
 *
 * Relative on purpose. "New" has to mean *new relative to this inbox* — if it
 * were relative to the wall clock, the same inbox would sort differently
 * tomorrow and the sort would be impossible to reason about while triaging.
 */
export type ScoreRecencyContext = {
  oldestReceivedAt: number;
  newestReceivedAt: number;
};

export function recencyWindow(timestamps: readonly number[]): ScoreRecencyContext | null {
  if (timestamps.length === 0) return null;
  let oldest = Infinity;
  let newest = -Infinity;
  for (const value of timestamps) {
    if (value < oldest) oldest = value;
    if (value > newest) newest = value;
  }
  return { oldestReceivedAt: oldest, newestReceivedAt: newest };
}

/**
 * Up to `MAX_RECENCY_BONUS` points, interpolated across the scored set's age
 * span: the newest message gets all of it, the oldest gets none.
 *
 * Messages outside the window clamp to its edges, and a degenerate window (one
 * timestamp, or all identical) yields 0 — there is nothing to prioritise
 * against, so the nudge is simply absent rather than arbitrary.
 */
export function relativeRecencyBonus(
  receivedAt: number,
  context: ScoreRecencyContext | null,
  maxBonus = MAX_RECENCY_BONUS,
): number {
  if (!context || context.newestReceivedAt <= context.oldestReceivedAt) return 0;
  const span = context.newestReceivedAt - context.oldestReceivedAt;
  const clamped = Math.min(context.newestReceivedAt, Math.max(context.oldestReceivedAt, receivedAt));
  return Math.round((maxBonus * (clamped - context.oldestReceivedAt)) / span);
}

/**
 * Score a message 0–100.
 *
 * Spam likelihood is honoured, so the sort can never float phishing to the top
 * of a bucket — which is what would happen if this scored purely on intent.
 */
export function calculateWinnowScore(
  email: Email,
  signals: EmailSignals,
  profile: UserProfile,
  recency: ScoreRecencyContext | null = null,
): number {
  let score = 50;

  score += senderRankBonus(profile, email.sender);
  score -= Math.trunc(trashBiasFor(profile, email.sender) * 40);
  score -= Math.trunc(signals.spamLikelihood * 40);
  if (email.starred) score += 15;

  // Subject and body only, matching `classify` — the sender address is not a
  // statement of intent.
  const text = `${email.subject} ${email.body}`;
  for (const { pattern, weight } of INTENT_PATTERNS) {
    if (pattern.test(text)) score += weight;
  }

  score += relativeRecencyBonus(email.receivedAt, recency);

  return Math.max(0, Math.min(100, score));
}

/** How the list can be ordered. */
export const SORT_OPTIONS = [
  { id: "date", label: "Date" },
  { id: "sender", label: "Sender" },
  { id: "score", label: "Smart Score" },
] as const;

export type SortBy = (typeof SORT_OPTIONS)[number]["id"];

export const DEFAULT_SORT: SortBy = "date";

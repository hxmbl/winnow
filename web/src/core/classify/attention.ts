/**
 * What needs you, as one sentence.
 *
 * The triage view's top line: "3 waiting on you, 1 security alert and 2 deliveries
 * today". Derived entirely from signals the classifier already produced, so it costs no
 * request and cannot disagree with the rail — a message counted here is one the
 * matching filter would also show.
 *
 * Deliberately narrow. Each clause is a reason to open the app *now*, so each one is
 * scoped to mail that is still live:
 *
 *   - **waiting on you** — unread, and the classifier's `needsAction` fired (the same
 *     predicate as the "Action needed" bucket). Read mail is not waiting; it has been
 *     seen.
 *   - **security alerts** — unread security mail. A sign-in alert you already read is
 *     history.
 *   - **deliveries today** — shipping mail that arrived today, read or not, because
 *     "it's arriving today" stays true after you open the email.
 *
 * Unsafe mail is excluded from every clause: the line must never advertise a phishing
 * lure as something that needs you.
 */

import { dayBucket } from "../mail/datetime";
import type { Email } from "../model/email";
import { isUnsafe, type EmailSignals } from "../model/signals";

export type AttentionSummary = {
  /** Unread mail the classifier thinks asks something of you. */
  waiting: number;
  /** Unread security mail. */
  security: number;
  /** Shipping mail that arrived today. */
  deliveries: number;
};

export const NO_ATTENTION: AttentionSummary = { waiting: 0, security: 0, deliveries: 0 };

/** Count the clauses over the inbox. `now` is the store's instant, so the demo's fixed day governs. */
export function summarizeAttention(
  inbox: readonly Email[],
  signals: ReadonlyMap<number, EmailSignals>,
  now: number,
): AttentionSummary {
  let waiting = 0;
  let security = 0;
  let deliveries = 0;
  for (const email of inbox) {
    if (email.mailbox !== "inbox") continue;
    const s = signals.get(email.id);
    if (!s || isUnsafe(s)) continue;
    if (email.unread && s.needsAction && !s.newsletter) waiting += 1;
    if (email.unread && s.security) security += 1;
    if (s.shipping && dayBucket(email.receivedAt, now) === "today") deliveries += 1;
  }
  return { waiting, security, deliveries };
}

/** "a, b and c": the way the sentence would be said aloud. */
function joinClauses(clauses: readonly string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? "";
  return `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
}

/**
 * The sentence. No trailing full stop: it is a heading, not a paragraph.
 *
 * When nothing qualifies it says so plainly, rather than rendering nothing: an empty line
 * would read as "still loading".
 */
export function attentionSentence(summary: AttentionSummary): string {
  const clauses: string[] = [];
  if (summary.waiting > 0) clauses.push(`${summary.waiting} waiting on you`);
  if (summary.security > 0) {
    clauses.push(`${summary.security} security ${summary.security === 1 ? "alert" : "alerts"}`);
  }
  if (summary.deliveries > 0) {
    clauses.push(`${summary.deliveries} ${summary.deliveries === 1 ? "delivery" : "deliveries"} today`);
  }
  if (clauses.length === 0) return "Nothing needs you right now";
  return joinClauses(clauses);
}

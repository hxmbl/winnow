/**
 * Does this message belong in this bucket?
 *
 * One predicate, shared by the list pipeline, the rail ranking and the badge
 * renderer. That sharing is the point: when these were three separate
 * implementations, the "Important" filter matched at 56 while the "Important"
 * badge only appeared at 70, so messages existed in a filter with no badge and
 * users could not tell which threshold they were looking at.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Classification/FilterMatching.swift`
 * and `FilterCatalog.swift`.
 */

import type { Email } from "../model/email";
import {
  BUILTIN_FILTERS,
  IMPORTANT_THRESHOLD,
  isUnsafe,
  PERMANENT_FILTERS,
  type BuiltinSmartFilter,
  type EmailSignals,
  type FilterId,
  catalogIndex,
} from "../model/signals";
import type { UserProfile } from "../model/profile";

/**
 * The importance score at or below which a message is skippable.
 *
 * Equal to the classifier's base score, which is what makes it the right
 * boundary: anything that earned no positive signal lands on it, and anything
 * that earned one is above it. "Read later" then means precisely what a user
 * wants from it — mail with no reason to open it now.
 */
export const SKIPPABLE_SCORE = 50;

/**
 * The bucket test.
 *
 * The recurring shape is `safe && …`: a message the classifier thinks is spam
 * must not appear in any bucket that means "worth your attention", or the
 * user reads a phishing lure by explicitly asking for Security.
 */
export function matchesBuiltin(
  filter: BuiltinSmartFilter,
  email: Email,
  signals: EmailSignals,
  profile: UserProfile,
): boolean {
  const safe = !isUnsafe(signals);

  switch (filter) {
    case "starred":
      return email.starred;

    case "important":
      // Important means it scores well or clearly needs action — but never
      // spam, and never bulk mail, which has its own buckets.
      return (
        safe &&
        ((signals.importanceScore >= IMPORTANT_THRESHOLD &&
          !signals.newsletter &&
          !signals.promotional) ||
          (signals.needsAction && !signals.promotional))
      );

    case "urgent":
      // Marketing "last chance!" is promo pressure, not urgency — unless the
      // sender explicitly flagged it.
      return signals.urgentText && safe && !(signals.promotional && !email.urgent);

    case "security":
      return signals.security;

    case "needs_action":
      // Newsletters are excluded: every issue "needs" a click, and counting
      // that would bury real asks under the weekly digest.
      return signals.needsAction && safe && !signals.newsletter;

    case "receipts":
      return signals.finance && safe;
    case "codes":
      return signals.codes && safe;
    case "shipping":
      return signals.shipping && safe;
    case "travel":
      return signals.travel && safe;
    case "events":
      return signals.events && safe;
    case "social":
      return signals.social && safe;

    case "new_senders":
      return safe && profile.firstTimeSenders.includes(email.sender);

    case "unread":
      return email.unread && safe;

    case "attachments":
      return email.attachments.length > 0 && safe;

    case "long_reads":
      // Substantive weekend reading: long, and nothing urgent, risky or
      // demanding. Deliberately overlaps "Read later" — a long thread is
      // usually both.
      return (
        signals.longRead &&
        safe &&
        !signals.newsletter &&
        !signals.promotional &&
        !signals.urgentText &&
        !signals.security &&
        !signals.needsAction
      );

    case "newsletters":
      return signals.newsletter;
    case "promotional":
      return signals.promotional;

    case "low_priority":
      // Genuinely skippable — not "is a newsletter". An earlier version used
      // `promotional || newsletter` here, which made Read later a synonym for
      // two buckets that already existed and hid quiet personal mail.
      //
      // The score test is `<= SKIPPABLE_SCORE`, where the base score is 50, and the
      // boundary is load-bearing in both directions. With a strict `< 50` a message
      // carrying no signal at all scored exactly 50 and was excluded, so the only
      // mail that could reach Read later was mail from a *penalised* sender — the
      // bucket meant "skippable" and selected for "quiet or demoted" instead. But
      // the symmetric mistake is just as bad: a 2FA code and a social mention both
      // score exactly 50 too, and filing those under Read later is precisely the
      // "hides mail you needed" failure the bucket exists to avoid.
      //
      // So the boundary holds the score and the *other* signals decide: anything
      // the user was explicitly asked to deal with is excluded by name, and
      // everything else that earned no positive signal falls in. That is what makes
      // "Read later" mean the same thing the classifier's own base score does —
      // mail with no reason to open it now.
      return (
        !email.starred &&
        !signals.urgentText &&
        !signals.security &&
        !signals.needsAction &&
        !signals.codes &&
        !signals.travel &&
        !signals.events &&
        !signals.shipping &&
        !signals.finance &&
        !signals.social &&
        signals.importanceScore <= SKIPPABLE_SCORE &&
        safe
      );

    case "unsafe":
      return isUnsafe(signals);

    case "top_contacts":
      return profile.topSenders.slice(0, 3).includes(email.sender);

    case "quiet_contacts":
      return profile.quietSenders.includes(email.sender);
  }
}

/** The bucket test plus the per-sender shortcut. */
export function matchesFilter(
  filter: FilterId,
  email: Email,
  signals: EmailSignals,
  profile: UserProfile,
): boolean {
  if (filter.kind === "sender") {
    // Case-insensitive: addresses are not case-sensitive in practice, and a
    // case-sensitive compare would let "Ada@x.com" and "ada@x.com" become two
    // senders with two biases and two pills.
    return email.sender.toLowerCase() === filter.sender.toLowerCase();
  }
  return matchesBuiltin(filter.id, email, signals, profile);
}

/**
 * How many messages in the inbox land in each bucket.
 *
 * `unsafe` is the exception, and it has to be. Every other bucket is defined with
 * a `safe && …` guard — a message the classifier thinks is junk must not appear
 * in a bucket that means "worth your attention", or the user reads a phishing
 * lure by explicitly asking for Security. The `unsafe` bucket *is* the junk, so
 * counting it the same way would report the safety valve as permanently empty and
 * pin it nowhere.
 *
 * So the guard is applied once, here, to every bucket except `unsafe`, rather than
 * being left to each predicate. Applying it per-predicate is what let spam into
 * the Security count anyway: `security` is the one positive bucket whose predicate
 * has no `safe` guard — `signals.security` is a fact about the message, not a
 * judgement about whether to show it — so a phished "your account is suspended"
 * notice was counted under Security *and* under Unsafe at the same time. That
 * inflated the count, and since the rail ranks by count, it also moved Security
 * above buckets that genuinely had more mail in them.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Classification/FilterCatalog.swift`,
 * which guards the loop rather than the predicates for the same reason.
 */
export function countAllFilters(
  inbox: readonly Email[],
  signals: ReadonlyMap<number, EmailSignals>,
  profile: UserProfile,
): Map<BuiltinSmartFilter, number> {
  const counts = new Map<BuiltinSmartFilter, number>();
  for (const email of inbox) {
    const signal = signals.get(email.id);
    if (!signal) continue;
    const safe = !isUnsafe(signal);
    for (const id of ALL_FILTER_IDS) {
      if (!safe && id !== "unsafe") continue;
      if (matchesBuiltin(id, email, signal, profile)) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

const ALL_FILTER_IDS: readonly BuiltinSmartFilter[] = BUILTIN_FILTERS;

/**
 * Order the rail for display.
 *
 * Three groups, and the grouping is the design:
 *
 *   1. **Permanent** — Important and Deliveries, pinned first *even when
 *      empty*. They are the two buckets a user reaches for on a bad day, and a
 *      pill that disappears exactly when you need it is worse than no pill.
 *   2. **Magic** — everything else with mail in it right now, busiest first.
 *      An empty bucket is hidden: it advertises a count of zero and offers
 *      nothing, so it just costs a slot in the rail.
 *   3. **Unsafe** — pinned last, as the deliberate safety valve. It is the one
 *      bucket you go to on purpose, so it never competes for position.
 *
 * Note that Unsafe is counted here even though the other buckets exclude spam
 * rows. Its members *are* the spam-scored rows, so skipping them would count
 * zero and pin it somewhere meaningless.
 */
export function rankFilters(
  inbox: readonly Email[],
  signals: ReadonlyMap<number, EmailSignals>,
  profile: UserProfile,
  removed: ReadonlySet<BuiltinSmartFilter> = new Set(),
): BuiltinSmartFilter[] {
  const counts = countAllFilters(inbox, signals, profile);

  const pinned = PERMANENT_FILTERS.filter((id) => !removed.has(id));

  const magic = BUILTIN_FILTERS.filter(
    (id) =>
      !PERMANENT_FILTERS.includes(id) &&
      id !== "unsafe" &&
      !removed.has(id) &&
      (counts.get(id) ?? 0) > 0,
  ).sort((a, b) => {
    const countA = counts.get(a) ?? 0;
    const countB = counts.get(b) ?? 0;
    if (countA !== countB) return countB - countA;
    // Equal counts fall back to catalog order, which is the canonical
    // high-signal-first ordering.
    return catalogIndex(a) - catalogIndex(b);
  });

  const unsafe = removed.has("unsafe") ? [] : (["unsafe"] as const);

  return [...pinned, ...magic, ...unsafe];
}

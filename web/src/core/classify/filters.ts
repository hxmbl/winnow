/**
 * Does this message belong in this bucket?
 *
 * One predicate shared by the list pipeline, the rail ranking and the badge
 * renderer, so a filter and its badge can never disagree about the threshold.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Classification/FilterMatching.swift`
 * and `FilterCatalog.swift`.
 */

import type { Email } from "../model/email";
import {
  BUILTIN_FILTERS,
  inSignalFilter,
  isSignalFilter,
  isUnsafe,
  PERMANENT_FILTERS,
  type BuiltinSmartFilter,
  type EmailSignals,
  type FilterId,
  catalogIndex,
  NEUTRAL_SIGNALS,
} from "../model/signals";
import type { UserProfile } from "../model/profile";

/**
 * The importance score at or below which a message is skippable: the classifier's
 * base score. Anything that earned no positive signal lands on it, and anything
 * that earned one is above it — so "Read later" is mail with no reason to open it
 * now.
 */
export const SKIPPABLE_SCORE = 50;

/**
 * The bucket test.
 *
 * **The `safe` guard is applied once, in `countAllFilters`, not here.** `starred`,
 * `security`, `newsletters`, `promotional`, `top_contacts` and `quiet_contacts`
 * deliberately have no spam guard: each is a statement about the message — you
 * starred it, it *is* a security notice — and gating them would empty "Security"
 * for the one message the user most wants filed there.
 *
 * The consequence, stated rather than hidden: clicking one of those buckets *can*
 * surface unsafe mail. The count a pill shows is guarded; the list behind it is
 * not, by design.
 */
export function matchesBuiltin(
  filter: BuiltinSmartFilter,
  email: Email,
  signals: EmailSignals,
  profile: UserProfile,
): boolean {
  const safe = !isUnsafe(signals);

  // The filters a correction can change are answered by one shared predicate, which
  // reads the user's per-filter correction first. The badge asks the same function.
  if (isSignalFilter(filter)) return inSignalFilter(filter, email, signals);

  switch (filter) {
    case "starred":
      return email.starred;

    case "new_senders":
      return safe && profile.firstTimeSenders.includes(email.sender);

    case "unread":
      return email.unread && safe;

    case "attachments":
      // `attachmentHint` stands in until a metadata-only message's body (and its real
      // attachment list) has been loaded.
      return (email.attachments.length > 0 || email.attachmentHint === true) && safe;

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

    case "low_priority":
      // Genuinely skippable — not "is a newsletter". The score test is
      // `<= SKIPPABLE_SCORE`, and the boundary is load-bearing both ways: a strict
      // `< 50` excluded a message carrying no signal at all (it scored exactly 50),
      // while a 2FA code and a social mention also score exactly 50, and the named
      // signals keep those out.
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
 * `unsafe` is the exception: every other bucket is guarded with `safe && …`, and
 * the `unsafe` bucket *is* the junk, so counting it the same way would leave the
 * safety valve permanently empty. The guard is applied here, once, rather than per
 * predicate — `security` has no guard of its own, so a phished notice was counted
 * under Security *and* Unsafe, inflating the count the rail ranks by.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Classification/FilterCatalog.swift`,
 * which guards the loop rather than the predicates for the same reason.
 */
export function countAllFilters(
  inbox: readonly Email[],
  signals: ReadonlyMap<number, EmailSignals>,
  profile: UserProfile,
  /**
   * Optional per-message memo, for the store: the filters one message is in depend only
   * on (message, signals, profile), so a pass after one message changed recounts one.
   */
  memo?: WeakMap<Email, { signal: EmailSignals; profile: UserProfile; ids: readonly BuiltinSmartFilter[] }>,
): Map<BuiltinSmartFilter, number> {
  const counts = new Map<BuiltinSmartFilter, number>();
  for (const email of inbox) {
    const signal = signals.get(email.id);
    if (!signal) continue;
    const hit = memo?.get(email);
    const ids = hit && hit.signal === signal && hit.profile === profile ? hit.ids : filtersFor(email, signal, profile);
    if (memo && ids !== hit?.ids) memo.set(email, { signal, profile, ids });
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Every built-in filter one message is in. An unsafe message is in Unsafe only. */
export function filtersFor(email: Email, signal: EmailSignals, profile: UserProfile): BuiltinSmartFilter[] {
  const safe = !isUnsafe(signal);
  const ids: BuiltinSmartFilter[] = [];
  for (const id of ALL_FILTER_IDS) {
    if (!safe && id !== "unsafe") continue;
    if (matchesBuiltin(id, email, signal, profile)) ids.push(id);
  }
  return ids;
}

const ALL_FILTER_IDS: readonly BuiltinSmartFilter[] = BUILTIN_FILTERS;

/**
 * Every built-in filter one message *lists* under: `matchesBuiltin` with no spam guard,
 * the list's own test (`runInboxQuery`). Unlike `filtersFor`, an unsafe message can be
 * in Starred or Security here, because that is what the list behind those pills shows.
 */
export function listedFiltersFor(email: Email, signal: EmailSignals, profile: UserProfile): BuiltinSmartFilter[] {
  const ids: BuiltinSmartFilter[] = [];
  for (const id of ALL_FILTER_IDS) if (matchesBuiltin(id, email, signal, profile)) ids.push(id);
  return ids;
}

/**
 * The rail's counts once a filter is on (1.4.0): faceted on the active set.
 *
 * Several active filters narrow the list (AND, `runInboxQuery`), so a pill that is *off*
 * counts the messages the list would show if it were turned on as well — the current
 * result that it also matches — and a pill that is *on* counts the current result
 * itself. Both are the list's own semantics (`matchesFilter`, no spam guard), so the
 * number on a pill is exactly what tapping it gives (under the search too, below).
 *
 * One exception, from `toggleFilter`: Unsafe is exclusive, so turning it on *replaces*
 * the set. While it is off its count is what Unsafe alone lists, not the intersection.
 *
 * With a search running (1.4.0) the caller passes only the search's matches (the list's
 * own test, `matchesSearch`) and `searching`, so every count above is also ANDed with
 * the search, nothing on included: an off pill counts search ∧ filters ∧ pill, an on
 * pill the current (searched) result, and an off Unsafe what Unsafe alone lists under
 * the search, since `toggleFilter` replaces the filters and leaves the query alone.
 *
 * `null` with nothing active and no search: the rail then shows the plain per-bucket
 * counts (`countAllFilters`), unchanged.
 */
export type FacetCounts = {
  /** Messages the active set admits: the current result (searched, while searching). */
  total: number;
  builtin: ReadonlyMap<BuiltinSmartFilter, number>;
  /** By lowercased sender, as sender filters match (`matchesFilter`). */
  senders: ReadonlyMap<string, number>;
};

export function countFacets(
  emails: readonly Email[],
  signals: ReadonlyMap<number, EmailSignals>,
  profile: UserProfile,
  active: readonly FilterId[],
  /** Per-message memo of `listedFiltersFor`, like `countAllFilters`'s. */
  memo?: WeakMap<Email, { signal: EmailSignals; profile: UserProfile; ids: readonly BuiltinSmartFilter[] }>,
  /**
   * True while a search is running (1.4.0): `emails` are then the search's matches,
   * and the counts are faceted even with nothing on, since every pill must count what
   * tapping it gives under that search rather than the plain bucket size.
   */
  searching = false,
): FacetCounts | null {
  if (active.length === 0 && !searching) return null;
  const builtinActive = active.flatMap((filter) => (filter.kind === "builtin" ? [filter.id] : []));
  const senderActive = active.flatMap((filter) => (filter.kind === "sender" ? [filter.sender.toLowerCase()] : []));
  const unsafeOn = builtinActive.includes("unsafe");

  const builtin = new Map<BuiltinSmartFilter, number>();
  const senders = new Map<string, number>();
  let total = 0;
  let unsafeAlone = 0;
  for (const email of emails) {
    const signal = signals.get(email.id) ?? NEUTRAL_SIGNALS;
    const hit = memo?.get(email);
    const ids = hit && hit.signal === signal && hit.profile === profile ? hit.ids : listedFiltersFor(email, signal, profile);
    if (memo && ids !== hit?.ids) memo.set(email, { signal, profile, ids });
    if (ids.includes("unsafe")) unsafeAlone += 1;
    const sender = email.sender.toLowerCase();
    if (!senderActive.every((s) => s === sender)) continue;
    if (!builtinActive.every((id) => ids.includes(id))) continue;
    total += 1;
    for (const id of ids) builtin.set(id, (builtin.get(id) ?? 0) + 1);
    senders.set(sender, (senders.get(sender) ?? 0) + 1);
  }
  if (!unsafeOn) builtin.set("unsafe", unsafeAlone);
  return { total, builtin, senders };
}

/**
 * Order the rail for display.
 *
 * Three groups, and the grouping is the design:
 *
 *   1. **Permanent** — Important and Deliveries, pinned first *even when empty*.
 *      A pill that disappears exactly when you need it is worse than no pill.
 *   2. **Magic** — everything else with mail in it right now, busiest first. An
 *      empty bucket just costs a slot in the rail.
 *   3. **Unsafe** — pinned last, the one bucket you go to on purpose, so it never
 *      competes for position.
 */
export function rankFilters(
  inbox: readonly Email[],
  signals: ReadonlyMap<number, EmailSignals>,
  profile: UserProfile,
): BuiltinSmartFilter[] {
  const counts = countAllFilters(inbox, signals, profile);

  const pinned = [...PERMANENT_FILTERS];

  const magic = BUILTIN_FILTERS.filter(
    (id) =>
      !PERMANENT_FILTERS.includes(id) &&
      id !== "unsafe" &&
      (counts.get(id) ?? 0) > 0,
  ).sort((a, b) => {
    const countA = counts.get(a) ?? 0;
    const countB = counts.get(b) ?? 0;
    if (countA !== countB) return countB - countA;
    // Equal counts fall back to catalog order, which is the canonical
    // high-signal-first ordering.
    return catalogIndex(a) - catalogIndex(b);
  });

  return [...pinned, ...magic, "unsafe"];
}

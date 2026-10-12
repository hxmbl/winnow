/**
 * Matching a query against the index, and deciding what to offer.
 *
 * The two halves of one question — "does this person match what has been typed?" and
 * "of those, who is most likely the one meant?" — are separate on purpose. The first is
 * about text and belongs to `matchKey`; the second is about history and belongs here, so
 * that changing the ranking cannot accidentally change what counts as a match.
 *
 * Eight is the cap because the list is read by eye while typing: a ninth row is below the
 * fold in the composer at any window narrower than about 900px, and a suggestion that has
 * to be scrolled to is one nobody picks.
 */

import { foldText, normalizeAddress } from "./addresses";
import { matchKey, type ContactEntry, type ContactIndex, type MatchKey } from "./index";

/** How many suggestions are ever offered. */
export const MAX_SUGGESTIONS = 8;

/** Why a row is in the list, for the secondary line under the name. */
export type MatchReason = "name" | "local" | "domain" | "address";

export type Suggestion = {
  address: string;
  name?: string;
  reason: MatchReason;
};

/**
 * How well a match fits, before history is applied.
 *
 * Multipliers rather than a tiers enum, because the interesting property is the *gap*
 * between them: typing a name should not be the same evidence as typing half a domain, and
 * typing a domain should still find someone. A prefix beats a substring at every level,
 * so `ada@` offers Ada at the top of the list rather than wherever she happens to fall.
 */
const MATCH = {
  addressPrefix: 8,
  addressInside: 6,
  namePrefix: 5,
  wordPrefix: 4,
  nameInside: 3,
  localPrefix: 3,
  localInside: 2,
  domainPrefix: 1.5,
  domainInside: 1,
} as const;

/**
 * The best the entry can offer for this query, or `null` for no match at all.
 *
 * `foldedQuery` must already be folded — `suggestContacts` is the entry point that folds,
 * once, because this runs per candidate and folding is not free.
 */
export function matchScore(key: MatchKey, foldedQuery: string): number | null {
  // An empty query matches everything. That is the deliberate behaviour of a list that
  // opens on the field: the most frequent people are what the user is reaching for when
  // they have not yet decided who they are writing to.
  if (foldedQuery === "") return 1;

  // Once there is an `@` the user is typing an address, and matching on somebody's *name*
  // would be actively unhelpful — `dana@` is a statement about the address, not a search.
  if (foldedQuery.includes("@")) {
    if (key.address.startsWith(foldedQuery)) return MATCH.addressPrefix;
    if (key.address.includes(foldedQuery)) return MATCH.addressInside;
    return null;
  }

  let best: number | null = null;
  const consider = (score: number): void => {
    if (best === null || score > best) best = score;
  };

  if (key.name.startsWith(foldedQuery)) consider(MATCH.namePrefix);
  if (key.words.some((word) => word.startsWith(foldedQuery))) consider(MATCH.wordPrefix);
  if (key.name.includes(foldedQuery)) consider(MATCH.nameInside);
  if (key.local.startsWith(foldedQuery)) consider(MATCH.localPrefix);
  if (key.local.includes(foldedQuery)) consider(MATCH.localInside);
  if (key.domain.startsWith(foldedQuery)) consider(MATCH.domainPrefix);
  if (key.domain.includes(foldedQuery)) consider(MATCH.domainInside);

  return best;
}

/** The reason to print for a match, which is the weakest field that matched. */
function reasonFor(key: MatchKey, foldedQuery: string): MatchReason {
  if (foldedQuery.includes("@")) return "address";
  if (key.name.startsWith(foldedQuery) || key.name.includes(foldedQuery)) return "name";
  if (key.words.some((word) => word.startsWith(foldedQuery))) return "name";
  if (key.local.includes(foldedQuery)) return "local";
  return "domain";
}

export type SuggestOptions = {
  /**
   * Addresses to leave out — the ones already on the To line.
   *
   * Compared folded, so a chip holding `Ada@Example.com` still excludes
   * `ada@example.com`. Excluded rather than ranked down: offering somebody who is already
   * on the message is offering to send them it twice.
   */
  exclude?: Iterable<string>;
  /** Over the cap, for tests. */
  limit?: number;
};

/**
 * The people worth offering, best first.
 *
 * History decides the order and the cap; the match only decides membership and, as a
 * multiplier, the relative order of two people who are otherwise equally likely. Ties on
 * the final number break alphabetically, so the same query over the same mail always
 * returns the same list.
 */
export function suggestContacts(
  index: ContactIndex,
  query: string,
  options: SuggestOptions = {},
): Suggestion[] {
  const foldedQuery = foldText(query.trim());
  const excluded = new Set<string>();
  for (const address of options.exclude ?? []) {
    excluded.add(normalizeAddress(address));
  }
  const limit = options.limit ?? MAX_SUGGESTIONS;

  const scored: { suggestion: Suggestion; score: number }[] = [];

  for (const entry of index.entries) {
    if (excluded.has(normalizeAddress(entry.address))) continue;
    const key = matchKey(entry);
    const fit = matchScore(key, foldedQuery);
    if (fit === null) continue;
    scored.push({
      suggestion: { address: entry.address, name: entry.name, reason: reasonFor(key, foldedQuery) },
      score: entry.score * fit,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.suggestion.address.localeCompare(b.suggestion.address));
  return scored.slice(0, limit).map((row) => row.suggestion);
}

/**
 * The display label for a chip.
 *
 * A name is worth more than an address a person recognises themselves by, but only if
 * the index has one — so the index is consulted first and the address is the fallback,
 * never a blank chip and never "undefined".
 */
export function chipLabel(address: string, index: ContactIndex | null): string {
  if (!index) return address;
  return index.byAddress.get(normalizeAddress(address))?.name ?? address;
}

/**
 * Whether a suggestion should be offered at all, once the chips are counted.
 *
 * A narrow helper for the one question the composer asks on every keystroke and that has
 * a non-obvious answer: an address that is already a chip is never offered, whatever the
 * ranking says.
 */
export function isAlreadyOnMessage(address: string, recipients: readonly string[]): boolean {
  const key = normalizeAddress(address);
  return recipients.some((entry) => normalizeAddress(entry) === key);
}

export type { ContactEntry, ContactIndex };
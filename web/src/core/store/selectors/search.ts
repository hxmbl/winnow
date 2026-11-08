/**
 * Search-aware facet counts for the rail.
 *
 * The list's own tokens and matcher are used over the bags the derive pass already
 * built, so a chip searches exactly as the list does. The cache is here rather than on
 * the store because a version bump that moved nothing the counts read (a clock tick, a
 * selection, the reader loading a body) should reuse the last pass.
 */

import type { Email } from "../../model/email";
import type { BuiltinSmartFilter, EmailSignals, FilterId } from "../../model/signals";
import { searchTokens, matchesSearch, type SearchBags } from "../../classify/pipeline";
import { countFacets, type FacetCounts } from "../../classify/filters";
import type { UserProfile } from "../../model/profile";

type FacetCache = {
  filters: readonly FilterId[];
  /** The search's tokens, joined: a keystroke that changes them is one rescan. */
  search: string;
  profile: UserProfile;
  emails: readonly Email[];
  signals: readonly (EmailSignals | undefined)[];
  facets: FacetCounts | null;
};

export class SearchFacets {
  /**
   * The filters each message object *lists* under (no spam guard), for `railFacets`.
   */
  readonly listedHits = new WeakMap<
    Email,
    { signal: EmailSignals; profile: UserProfile; ids: readonly BuiltinSmartFilter[] }
  >();

  private cache: FacetCache | null = null;

  /**
   * Faceted on the active filters and, while a search runs (1.4.0), on the search: a
   * chip's number is then what tapping it lists under that query.
   */
  facetsFor(
    filters: readonly FilterId[],
    searchQuery: string,
    emails: readonly Email[],
    signals: ReadonlyMap<number, EmailSignals>,
    profile: UserProfile,
    searchBags: SearchBags,
  ): FacetCounts | null {
    const tokens = searchTokens(searchQuery);
    if (filters.length === 0 && tokens.length === 0) return null;
    const search = tokens.join(" ");
    const hit = this.cache;
    if (
      hit &&
      hit.filters === filters &&
      hit.search === search &&
      hit.profile === profile &&
      hit.emails.length === emails.length &&
      emails.every((email, i) => hit.emails[i] === email && hit.signals[i] === signals.get(email.id))
    ) {
      return hit.facets;
    }
    const searched = tokens.length > 0 ? emails.filter((email) => matchesSearch(email, tokens, searchBags)) : emails;
    const facets = countFacets(searched, signals, profile, filters, this.listedHits, tokens.length > 0);
    this.cache = { filters, search, profile, emails, signals: emails.map((email) => signals.get(email.id)), facets };
    return facets;
  }
}

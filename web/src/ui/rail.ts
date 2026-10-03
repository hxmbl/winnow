/**
 * The filter rail's data.
 *
 * `buildPills` lives here rather than in `FilterStrip.tsx` for one reason: that
 * file renders React, and a component module that also exports plain functions
 * breaks fast refresh — the rule exists because a module exporting both is
 * reloaded as a unit, so editing the component would reset the function too.
 *
 * This is also the only place that decides what the rail *contains*, which makes
 * it the natural home for the one genuinely tricky rule below.
 */

import {
  FILTER_LABELS,
  type BuiltinSmartFilter,
  type FilterId,
} from "../core/model/signals";
import { FILTER_PILLS, senderPillColors, type PillColors } from "./filterColors";

export type PillItem = {
  id: FilterId;
  label: string;
  colors: PillColors;
  /**
   * How many messages this bucket holds in the *inbox*.
   *
   * Inbox-wide, not "in the current view", and that distinction is the reason this
   * function takes its counts from the store rather than deriving them: the rail is
   * ranked against the inbox so it stays put when you change mailbox, and a count
   * that meant something else would put a number on a pill that contradicts the rank
   * beside it.
   */
  count: number;
  /**
   * Muted by the user: drawn struck through, with a restore control.
   *
   * Optional because a pill's mutability is a property of the *bucket*, not of the
   * sender pills — and sender pills have no such state, because there is no learning
   * to do from silencing one person. `buildPills` sets it for every builtin pill
   * (true or false), so the component can branch on `id.kind === "builtin"` and this
   * field together.
   */
  muted?: boolean;
};

/**
 * Build the rail's items from the store's ranked buckets and the counts.
 *
 * `muted` is passed in rather than derived, because the store is what knows: a muted
 * bucket is instance state on the store (it survives a reload from persistence, and
 * a bucket the user muted must stay muted), and it is *not* inferable from the counts
 * — a muted bucket with mail in it and a live bucket with mail in it have identical
 * counts.
 *
 * A muted pill is drawn struck through, with its dismiss button replaced by a restore
 * one. That is the whole reason muting is reversible from the rail: without the
 * marker, a muted pill is indistinguishable from an active one, its ✕ calls a
 * no-op, and the user is left with a setting they cannot undo.
 */
export function buildPills(
  rail: readonly BuiltinSmartFilter[],
  counts: ReadonlyMap<BuiltinSmartFilter, number>,
  topSenders: readonly string[],
  senderCounts: ReadonlyMap<string, number>,
  activeFilters: readonly FilterId[],
  mutedFilters: readonly BuiltinSmartFilter[] = [],
): PillItem[] {
  const muted = new Set(mutedFilters);
  // A muted bucket is at the end of the rail and is not filterable, so it must not
  // take a digit — and the digits are assigned by position, which means muting a
  // bucket would otherwise silently repoint every shortcut after it. So the muted
  // pills are counted separately and take no index.
  const buckets: PillItem[] = rail
    .filter((id) => !muted.has(id))
    .map((id) => ({
      id: { kind: "builtin", id },
      label: FILTER_LABELS[id],
      colors: FILTER_PILLS[id],
      count: counts.get(id) ?? 0,
      muted: false,
    }));

  const mutedBuckets: PillItem[] = rail
    .filter((id) => muted.has(id))
    .map((id) => ({
      id: { kind: "builtin", id },
      label: FILTER_LABELS[id],
      colors: FILTER_PILLS[id],
      count: counts.get(id) ?? 0,
      muted: true,
    }));

  /**
   * Sender pills, from the same engagement ranking the classifier uses, so
   * "the people I actually read" is at the top rather than being an alphabetical
   * accident.
   *
   * An *active* sender keeps its pill. Hiding it — as an earlier version did — is
   * a trap: the pill that turns a filter on then vanishes, so the only way to
   * turn it off is "All", a keyboard shortcut, or a reload. A control the pointer
   * cannot reach is not a control.
   */
  const senders: PillItem[] = topSenders.map((sender) => ({
    id: { kind: "sender", sender },
    label: `From ${sender}`,
    colors: senderPillColors(sender),
    count: senderCounts.get(sender) ?? 0,
  }));

  // An active sender that has dropped out of the top-N is appended rather than
  // dropped. Otherwise a pill disappears on its own as the engagement ranking
  // shifts underneath it, which reads as the app losing state — and the filter
  // would still be applied, invisibly.
  for (const filter of activeFilters) {
    if (filter.kind !== "sender") continue;
    if (senders.some((pill) => pill.id.kind === "sender" && pill.id.sender === filter.sender)) {
      continue;
    }
    senders.push({
      id: filter,
      label: `From ${filter.sender}`,
      colors: senderPillColors(filter.sender),
      count: senderCounts.get(filter.sender) ?? 0,
      muted: false,
    });
  }

  // Muted buckets last, so the digit-to-pill mapping is only ever shifted by buckets
  // that can actually be filtered by.
  return [...buckets, ...senders, ...mutedBuckets];
}

/**
 * The digit for a rail position, or `null` past the ninth pill.
 *
 * Shared so the printed shortcut and the rendered one cannot disagree: only nine
 * pills can have a digit, and a pill showing "10" as its key would be a lie.
 */
export function digitFor(index: number): string | null {
  return index < 9 ? String(index + 1) : null;
}
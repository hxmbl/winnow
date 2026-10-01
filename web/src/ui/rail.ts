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
  /** How many messages this bucket currently holds. */
  count: number;
  /** Muted by the user: shown separately, in a struck-through state. */
  muted?: boolean;
};

/** Build the rail's items from the store's ranked buckets and the counts. */
export function buildPills(
  rail: readonly BuiltinSmartFilter[],
  counts: ReadonlyMap<BuiltinSmartFilter, number>,
  topSenders: readonly string[],
  senderCounts: ReadonlyMap<string, number>,
  activeFilters: readonly FilterId[],
): PillItem[] {
  const buckets: PillItem[] = rail.map((id) => ({
    id: { kind: "builtin", id },
    label: FILTER_LABELS[id],
    colors: FILTER_PILLS[id],
    count: counts.get(id) ?? 0,
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
    });
  }

  return [...buckets, ...senders];
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
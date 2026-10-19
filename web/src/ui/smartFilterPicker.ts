/**
 * The rules behind "Change smart filters…", kept out of the component so they are tested.
 *
 * The picker lists every filter a correction can change (`LEARNABLE_FILTERS`), ticked
 * where the message is now. For several messages a filter can be on some of them: it
 * shows as mixed, and a click puts all of them in, the way Gmail's label picker does.
 * Each click is applied at once — the message moves while the picker is still open —
 * and is recorded as one correction per message.
 */

import { FILTER_LABELS } from "../core/model/signals";
import { LEARNABLE_FILTERS, type LearnableFilter } from "../core/learn/filterLearning";

export type FilterCheck = "all" | "some" | "none";

export type PickerRow = { filter: LearnableFilter; label: string; check: FilterCheck };

export function pickerRows(membership: ReadonlyMap<LearnableFilter, FilterCheck>): PickerRow[] {
  return LEARNABLE_FILTERS.map((filter) => ({
    filter,
    label: FILTER_LABELS[filter],
    check: membership.get(filter) ?? "none",
  }));
}

/** What a click on a row asks for: ticked → out, otherwise → in. */
export function clickInto(check: FilterCheck): boolean {
  return check !== "all";
}

/** The picker's title. */
export function pickerTitle(count: number): string {
  return count === 1 ? "Smart filters" : `Smart filters for ${count} messages`;
}

/** What one change did, as `Store.changeSmartFilters` reports it. */
export type ChangeOutcome = { into: boolean; moved: number; unsafe: number; already: number };

/**
 * The status line after a click, saying only what really happened: "Moved" only when
 * membership changed, and for unsafe mail — which learning never puts into a filter —
 * what to do instead. `selected` is how many messages the picker was opened for.
 */
export function changeNotice(label: string, outcome: ChangeOutcome, selected: number): string {
  const { into, moved, unsafe } = outcome;
  const where = into ? `into ${label}` : `out of ${label}`;
  const parts: string[] = [];
  if (moved > 0) {
    if (selected === 1) parts.push(`Moved ${where}.`);
    else if (moved === selected) parts.push(`Moved ${moved} messages ${where}.`);
    else parts.push(`Moved ${moved} of ${selected} messages ${where}.`);
  }
  if (unsafe > 0) {
    if (selected === 1) parts.push(`This message looks unsafe. Mark it not spam first to put it in ${label}.`);
    else if (unsafe === 1) parts.push(`One looks unsafe. Mark it not spam first to put it in ${label}.`);
    else parts.push(`${unsafe} look unsafe. Mark them not spam first to put them in ${label}.`);
  }
  if (parts.length === 0) {
    if (into) return selected === 1 ? `Already in ${label}.` : `All already in ${label}.`;
    return selected === 1 ? `Not in ${label}.` : `None are in ${label}.`;
  }
  return parts.join(" ");
}

/** "Change smart filters…", the one name every entry point uses. */
export const CHANGE_FILTERS_LABEL = "Change smart filters…";

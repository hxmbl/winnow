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

/** What the picker says once something has moved, for the status line. */
export function movedNotice(label: string, into: boolean, count: number): string {
  const what = count === 1 ? "Moved" : `Moved ${count} messages`;
  return into ? `${what} into ${label}.` : `${what} out of ${label}.`;
}

/** "Change smart filters…", the one name every entry point uses. */
export const CHANGE_FILTERS_LABEL = "Change smart filters…";

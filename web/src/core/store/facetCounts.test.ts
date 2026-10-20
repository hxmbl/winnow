/**
 * Faceted rail counts (1.4.0): with a filter on, every pill's number is what the list
 * would show if that pill were turned on too, and an on pill's is the current result.
 *
 * The oracle is the store itself: turn the combination on in a fresh store and count
 * the list. Filters AND (`runInboxQuery`), and Unsafe replaces the set (`toggleFilter`).
 */

import { describe, expect, it } from "vitest";
import { WinnowStore } from "./store";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import { builtinFilter, filterKey, senderFilter, type FilterId } from "../model/signals";
import { buildPills } from "../../ui/rail";

function demoStore(filters: readonly FilterId[] = [], mailbox?: "trash") {
  const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
  store.attach({ onPersist: () => undefined });
  if (mailbox) store.setMailbox(mailbox);
  for (const filter of filters) store.toggleFilter(filter);
  return store;
}

/** Messages the list shows for a set of toggles, before search. */
function listed(filters: readonly FilterId[], mailbox?: "trash"): number {
  return demoStore(filters, mailbox).view.emails.length;
}

function pillsOf(store: WinnowStore) {
  const view = store.view;
  return buildPills(view.rail, view.railCounts, view.profile.topSenders, view.railSenderCounts, store.getSnapshot().activeFilters, view.railFacets);
}

const COMBOS: FilterId[][] = [
  [builtinFilter("unread")],
  [builtinFilter("important")],
  [builtinFilter("unread"), builtinFilter("needs_action")],
  [builtinFilter("starred")],
  [builtinFilter("unsafe")],
];

describe("faceted rail counts", () => {
  it("with nothing on, nothing changes: no facets, the pills show the plain counts", () => {
    const store = demoStore();
    expect(store.view.railFacets).toBeNull();
    for (const pill of pillsOf(store)) {
      if (pill.id.kind === "builtin") expect(pill.count).toBe(store.view.railCounts.get(pill.id.id) ?? 0);
      else expect(pill.count).toBe(store.view.railSenderCounts.get(pill.id.sender) ?? 0);
    }
  });

  for (const combo of COMBOS) {
    const name = combo.map(filterKey).join(" + ");
    it(`${name}: every pill's number is what tapping it lists`, () => {
      const store = demoStore(combo);
      const result = store.view.emails.length;
      expect(store.view.railFacets?.total).toBe(result);
      const pills = pillsOf(store);
      expect(pills.length).toBeGreaterThan(0);
      for (const pill of pills) {
        const on = combo.some((filter) => filterKey(filter) === filterKey(pill.id));
        if (on) {
          expect(pill.count, `${filterKey(pill.id)} (on)`).toBe(result);
        } else {
          expect(pill.count, `${filterKey(pill.id)} (off)`).toBe(listed([...combo, pill.id]));
        }
      }
    });
  }

  it("a sender pill facets on the active bucket too", () => {
    const base = demoStore();
    const sender = base.view.profile.topSenders[0];
    expect(sender).toBeTruthy();
    const store = demoStore([builtinFilter("unread")]);
    const pill = pillsOf(store).find((p) => p.id.kind === "sender" && p.id.sender === sender);
    if (pill) expect(pill.count).toBe(listed([builtinFilter("unread"), senderFilter(sender)]));
    // Active sender: the result.
    const bySender = demoStore([senderFilter(sender)]);
    const own = pillsOf(bySender).find((p) => p.id.kind === "sender" && p.id.sender === sender)!;
    expect(own.count).toBe(bySender.view.emails.length);
  });

  it("an off Unsafe pill counts Unsafe alone, since turning it on replaces the set", () => {
    const store = demoStore([builtinFilter("unread")]);
    expect(store.view.railFacets?.builtin.get("unsafe")).toBe(listed([builtinFilter("unsafe")]));
  });

  it("narrowing dims a pill to 0 rather than taking it off the rail", () => {
    const plain = pillsOf(demoStore()).map((p) => filterKey(p.id));
    const store = demoStore([builtinFilter("starred")]);
    const faceted = pillsOf(store);
    expect(faceted.map((p) => filterKey(p.id))).toEqual(plain);
    expect(faceted.some((p) => p.count === 0)).toBe(true);
  });

  it("applies in another mailbox (Trash) the same way", () => {
    const seeded = demoStore();
    for (const email of seeded.view.emails.filter((_, i) => i % 2 === 0)) seeded.trash(email.id);
    seeded.setMailbox("trash");
    seeded.toggleFilter(builtinFilter("unread"));
    const result = seeded.view.emails.length;
    for (const pill of pillsOf(seeded)) {
      if (pill.id.kind === "builtin" && pill.id.id === "unread") expect(pill.count).toBe(result);
    }
    expect(seeded.view.railFacets?.total).toBe(result);
  });

  it("is memoised: a version bump that moves no mail reuses the same facets", () => {
    const store = demoStore([builtinFilter("unread")]);
    const before = store.view.railFacets;
    store.select(store.view.emails[0]!.id);
    expect(store.view.railFacets).toBe(before);
    store.toggleFilter(builtinFilter("important"));
    expect(store.view.railFacets).not.toBe(before);
  });
});

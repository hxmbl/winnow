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

function demoStore(filters: readonly FilterId[] = [], mailbox?: "trash", search = "") {
  const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
  store.attach({ onPersist: () => undefined });
  if (mailbox) store.setMailbox(mailbox);
  if (search) store.setSearchQuery(search);
  for (const filter of filters) store.toggleFilter(filter);
  return store;
}

/** Rows (conversations) the list shows for a set of toggles (and a search, if given). */
function listed(filters: readonly FilterId[], mailbox?: "trash", search = ""): number {
  return demoStore(filters, mailbox, search).view.threads.length;
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
      const result = store.view.threads.length;
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
    expect(own.count).toBe(bySender.view.threads.length);
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
    const result = seeded.view.threads.length;
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

  describe("under a search (1.4.0)", () => {
    // Broad, narrow, two tokens, and one whose Security hit is unsafe (the list hides it
    // with nothing on; tapping Security lists it, so the chip must count it).
    const SEARCHES = ["the", "order", "you re", "security", "  ACCOUNT "];
    const SEARCH_COMBOS: FilterId[][] = [[], ...COMBOS];

    for (const search of SEARCHES) {
      for (const combo of SEARCH_COMBOS) {
        const name = `"${search}" + ${combo.map(filterKey).join(" + ") || "nothing"}`;
        it(`${name}: every chip's number is what tapping it lists under the search`, () => {
          const store = demoStore(combo, undefined, search);
          const result = store.view.threads.length;
          if (combo.length > 0) expect(store.view.railFacets?.total).toBe(result);
          const pills = pillsOf(store);
          expect(pills.length).toBeGreaterThan(0);
          for (const pill of pills) {
            const on = combo.some((filter) => filterKey(filter) === filterKey(pill.id));
            if (on) expect(pill.count, `${filterKey(pill.id)} (on)`).toBe(result);
            else expect(pill.count, `${filterKey(pill.id)} (off)`).toBe(listed([...combo, pill.id], undefined, search));
          }
        });
      }
    }

    it("the chips stay put while typing: which chips appear is the plain mailbox ranking", () => {
      const plain = pillsOf(demoStore()).map((p) => filterKey(p.id));
      for (const search of ["t", "th", "the", "invoice", "zzzz-nothing"]) {
        const store = demoStore([], undefined, search);
        expect(pillsOf(store).map((p) => filterKey(p.id)), search).toEqual(plain);
      }
      // A search that matches nothing dims every chip to 0, none removed.
      const none = pillsOf(demoStore([], undefined, "zzzz-nothing"));
      expect(none.every((p) => p.count === 0)).toBe(true);
    });

    it("the search actually changes the numbers (not the plain counts)", () => {
      const plain = demoStore();
      const searched = demoStore([], undefined, "order");
      const important = (s: WinnowStore) => pillsOf(s).find((p) => p.id.kind === "builtin" && p.id.id === "important")!.count;
      expect(important(searched)).toBeLessThan(important(plain));
    });

    it("an off Unsafe chip counts Unsafe alone under the search (the search survives the toggle)", () => {
      for (const search of ["security", "you"]) {
        const store = demoStore([builtinFilter("unread")], undefined, search);
        expect(store.view.railFacets?.builtin.get("unsafe"), search).toBe(listed([builtinFilter("unsafe")], undefined, search));
      }
    });

    it("leaves the drawer's inboxCounts and the plain railCounts alone", () => {
      const plain = demoStore();
      const searched = demoStore([], undefined, "order");
      expect([...searched.view.inboxCounts]).toEqual([...plain.view.inboxCounts]);
      expect([...searched.view.railCounts]).toEqual([...plain.view.railCounts]);
    });

    it("clearing the search drops back to no facets (nothing on)", () => {
      const store = demoStore([], undefined, "order");
      expect(store.view.railFacets).not.toBeNull();
      store.setSearchQuery("");
      expect(store.view.railFacets).toBeNull();
    });

    it("is memoised per query: a bump that moves nothing reuses the facets, a keystroke recounts", () => {
      const store = demoStore([], undefined, "or");
      const before = store.view.railFacets;
      store.select(store.view.emails[0]!.id);
      expect(store.view.railFacets).toBe(before);
      // Same tokens (whitespace, case): no rescan.
      store.setSearchQuery("  OR ");
      expect(store.view.railFacets).toBe(before);
      store.setSearchQuery("ord");
      expect(store.view.railFacets).not.toBe(before);
    });

    it("applies in another mailbox (Trash) the same way", () => {
      const seeded = demoStore();
      for (const email of seeded.view.emails.filter((_, i) => i % 2 === 0)) seeded.trash(email.id);
      seeded.setMailbox("trash");
      seeded.setSearchQuery("the");
      const result = seeded.view.threads.length;
      expect(result).toBeGreaterThan(0);
      for (const pill of pillsOf(seeded)) {
        seeded.toggleFilter(pill.id);
        expect(pill.count, filterKey(pill.id)).toBe(seeded.view.threads.length);
        seeded.toggleFilter(pill.id);
      }
      expect(seeded.view.threads.length).toBe(result);
    });
  });
});

/**
 * STRM-441: the phone dock's Inbox tab, tapped while Inbox is already open, undoes a
 * smart filter and goes back to All; with no filter on it takes the list to its top; from
 * another mailbox it switches to Inbox as before. Driven through the real store with the
 * dock's own tap wiring (`tapTab`), the way `PhoneDock` calls it.
 */

import { describe, expect, it, vi } from "vitest";
import { WinnowStore } from "../core/store/store";
import { DEMO_EMAILS, DEMO_TRASH } from "../core/data/demo";
import { BUILTIN_FILTERS, builtinFilter, type BuiltinSmartFilter } from "../core/model/signals";
import type { Mailbox } from "../core/model/email";
import { tapTab } from "./phoneDock";

function demoStore() {
  const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
  store.attach({ onPersist: () => undefined });
  return store;
}

/** A filter with mail in it in the open mailbox, so turning it on narrows the list. */
function someFilter(store: WinnowStore): BuiltinSmartFilter {
  const id = BUILTIN_FILTERS.find((filter) => filter !== "unsafe" && (store.view.railCounts.get(filter) ?? 0) > 0);
  if (!id) throw new Error("demo inbox has no filled smart filter");
  return id as BuiltinSmartFilter;
}

/** Tap a dock tab the way `PhoneDock` does, against the store, as `App` wires it. */
function tap(store: WinnowStore, mailbox: Mailbox, scrollToTop: () => void) {
  const snapshot = store.getSnapshot();
  return tapTab(
    mailbox,
    { current: snapshot.mailbox === mailbox, filtering: snapshot.activeFilters.length > 0 },
    {
      onClearFilters: () => store.clearFilters(),
      scrollToTop,
      onSelectMailbox: (next) => {
        store.setOverlay("none");
        store.setMailbox(next);
      },
    },
  );
}

describe("the Inbox tab clears the smart filter (STRM-441)", () => {
  it("in Inbox with a filter on, a tap goes back to All and does not scroll", () => {
    const store = demoStore();
    const all = store.view.emails.length;
    store.toggleFilter(builtinFilter(someFilter(store)));
    expect(store.getSnapshot().activeFilters).toHaveLength(1);
    expect(store.view.emails.length).toBeLessThan(all);

    const scroll = vi.fn();
    expect(tap(store, "inbox", scroll)).toBe("clear-filters");
    expect(store.getSnapshot().activeFilters).toEqual([]);
    expect(store.getSnapshot().mailbox).toBe("inbox");
    expect(store.view.emails.length).toBe(all);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("clears every active filter at once, like the All chip", () => {
    const store = demoStore();
    const filled = BUILTIN_FILTERS.filter((id) => id !== "unsafe" && (store.view.railCounts.get(id) ?? 0) > 0);
    for (const id of filled.slice(0, 2)) store.toggleFilter(builtinFilter(id as BuiltinSmartFilter));
    expect(store.getSnapshot().activeFilters.length).toBeGreaterThan(0);
    tap(store, "inbox", () => undefined);
    expect(store.getSnapshot().activeFilters).toEqual([]);
  });

  it("in Inbox with no filter, a tap scrolls the list to the top and changes nothing else", () => {
    const store = demoStore();
    const before = store.getSnapshot();
    const scroll = vi.fn();
    expect(tap(store, "inbox", scroll)).toBe("scroll-top");
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().mailbox).toBe("inbox");
    expect(store.getSnapshot().activeFilters).toEqual(before.activeFilters);
  });

  it("a second tap after clearing scrolls to the top", () => {
    const store = demoStore();
    store.toggleFilter(builtinFilter(someFilter(store)));
    const scroll = vi.fn();
    expect(tap(store, "inbox", scroll)).toBe("clear-filters");
    expect(tap(store, "inbox", scroll)).toBe("scroll-top");
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("from another mailbox, a tap switches to Inbox as before, without scrolling", () => {
    const store = demoStore();
    store.setMailbox("sent");
    const scroll = vi.fn();
    expect(tap(store, "inbox", scroll)).toBe("select");
    expect(store.getSnapshot().mailbox).toBe("inbox");
    expect(scroll).not.toHaveBeenCalled();
  });

  it("from another mailbox with a filter on there, switching keeps today's behaviour (filters drop with the switch)", () => {
    const store = demoStore();
    store.setMailbox("trash");
    // A filter narrowed in the bin, then Inbox tapped: a plain mailbox switch, which has
    // always reset the filters (`setMailbox`), not the clear-filter gesture.
    const filled = BUILTIN_FILTERS.find((id) => id !== "unsafe" && (store.view.railCounts.get(id) ?? 0) > 0);
    if (filled) store.toggleFilter(builtinFilter(filled as BuiltinSmartFilter));
    expect(tap(store, "inbox", () => undefined)).toBe("select");
    expect(store.getSnapshot().mailbox).toBe("inbox");
    expect(store.getSnapshot().activeFilters).toEqual([]);
  });

  it("does not offer an undo for clearing a filter (filter changes are not undoable actions)", () => {
    const store = demoStore();
    store.toggleFilter(builtinFilter(someFilter(store)));
    tap(store, "inbox", () => undefined);
    expect(store.getSnapshot().undo).toBeNull();
  });
});

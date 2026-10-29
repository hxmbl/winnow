/**
 * Smart filters apply to whichever mailbox is open (1.3.3): the rail's counts, the list a
 * filter gives and "Why it's here" all come from the open mailbox, not the inbox.
 */

import { describe, expect, it } from "vitest";
import { WinnowStore } from "./store";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import { BUILTIN_FILTERS, builtinFilter, type BuiltinSmartFilter } from "../model/signals";
import { buildPills } from "../../ui/rail";
import type { Mailbox } from "../model/email";
import { threadKey } from "../model/ids";

function demoStore() {
  const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
  store.attach({ onPersist: () => undefined });
  return store;
}

/** Bin every inbox message `pick` selects, so the bin holds a known mix. */
function binSome(store: WinnowStore, pick: (index: number) => boolean): number[] {
  const ids = store.view.emails.filter((_, index) => pick(index)).map((email) => email.id);
  for (const id of ids) store.trash(id);
  return ids;
}

const filled = (store: WinnowStore) =>
  BUILTIN_FILTERS.filter((id) => id !== "unsafe" && (store.view.railCounts.get(id) ?? 0) > 0) as BuiltinSmartFilter[];

describe("smart filters in the open mailbox", () => {
  it("in the inbox, the pill counts are the inbox's (as before)", () => {
    const store = demoStore();
    expect([...store.view.railCounts]).toEqual([...store.view.inboxCounts]);
  });

  it("in the bin, every pill counts only binned mail, and a filter lists only binned mail", () => {
    const store = demoStore();
    const binned = new Set(binSome(store, (i) => i % 2 === 0));
    store.setMailbox("trash");
    const inTrash = store.getSnapshot().all.filter((email) => email.mailbox === "trash").length;
    expect(inTrash).toBeGreaterThan(0);
    const buckets = filled(store);
    expect(buckets.length).toBeGreaterThan(0);
    // The binned junk: a pill's count leaves it out, and a statement-about-the-message
    // filter (starred, security, contacts…) still lists it, by design (`matchesBuiltin`).
    store.toggleFilter(builtinFilter("unsafe"));
    const unsafe = new Set(store.view.emails.map((email) => email.id));
    store.toggleFilter(builtinFilter("unsafe"));
    for (const id of buckets) {
      const count = store.view.railCounts.get(id)!;
      expect(count).toBeLessThanOrEqual(inTrash);
      store.toggleFilter(builtinFilter(id));
      // The list a filter gives is the count on its pill (plus any junk), all from the bin.
      // The pill counts conversations, the list's rows, so count the result's threads.
      expect(new Set(store.view.emails.filter((email) => !unsafe.has(email.id)).map(threadKey)).size).toBe(count);
      for (const email of store.view.emails) expect(email.mailbox).toBe("trash");
      store.toggleFilter(builtinFilter(id));
    }
    // And something binned from the inbox is now counted here, not there.
    expect([...binned].some((id) => store.view.emails.some((email) => email.id === id))).toBe(true);
  });

  it("the inbox's own counts do not change because another mailbox is open", () => {
    const store = demoStore();
    binSome(store, (i) => i % 3 === 0);
    const inbox = new Map(store.view.inboxCounts);
    store.setMailbox("trash");
    expect(new Map(store.view.inboxCounts)).toEqual(inbox);
  });

  it("with no filter, the bin and spam folder show everything in them, unsafe or not", () => {
    const store = demoStore();
    for (const mailbox of ["trash", "spam", "archive"] as Mailbox[]) {
      store.setMailbox(mailbox);
      const there = store.getSnapshot().all.filter((email) => email.mailbox === mailbox).length;
      expect(store.view.emails.length).toBe(there);
    }
  });

  it("the sender pills count the open mailbox", () => {
    const store = demoStore();
    binSome(store, (i) => i < 4);
    store.setMailbox("trash");
    for (const [sender, count] of store.view.railSenderCounts) {
      expect(store.view.emails.filter((email) => email.sender === sender).length).toBe(count);
    }
  });

  it("switching mailbox resets the active filter (the existing, least surprising rule)", () => {
    const store = demoStore();
    store.toggleFilter(builtinFilter(filled(store)[0]!));
    store.setMailbox("archive");
    expect(store.getSnapshot().activeFilters).toEqual([]);
  });

  it("Why it's here explains a binned message from the bin's classification", () => {
    const store = demoStore();
    const [id] = binSome(store, (i) => i === 0);
    store.setMailbox("trash");
    const email = store.view.emails.find((candidate) => candidate.id === id)!;
    const reasons = store.explainSmartFilters(email.id);
    expect(Array.isArray(reasons)).toBe(true);
    // Every bucket it says the message is in is one whose filter lists it here.
    for (const reason of reasons) {
      const filter = reason.filter;
      if (!filter || !(store.view.railCounts.get(filter) ?? 0)) continue;
      store.toggleFilter(builtinFilter(filter));
      expect(store.view.emails.some((candidate) => candidate.id === id)).toBe(true);
      store.toggleFilter(builtinFilter(filter));
    }
  });

  it("drafts have no smart filters: an empty rail count", () => {
    const store = demoStore();
    store.setMailbox("drafts");
    expect([...store.view.railCounts.values()].every((count) => count === 0)).toBe(true);
  });

  it("the app's pills read the open mailbox's counts", () => {
    const store = demoStore();
    binSome(store, (i) => i % 2 === 1);
    store.setMailbox("trash");
    const pills = buildPills(store.view.rail, store.view.railCounts, store.view.profile.topSenders, store.view.railSenderCounts, []);
    for (const pill of pills) {
      if (pill.id.kind !== "builtin") continue;
      expect(pill.count).toBe(store.view.railCounts.get(pill.id.id) ?? 0);
    }
  });
});

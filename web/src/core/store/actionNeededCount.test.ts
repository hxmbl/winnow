/**
 * The rail and the masthead count the same thing: conversations, the list's rows.
 *
 * In the demo, "Action needed" on read 13 on its pill over a list (and a masthead
 * readout, `view.threads.length`) of 11: the pill counted messages, so a thread with
 * three replies in it counted 3 while the list showed it as one row. Both now count by
 * `threadKey`, the key `groupThreads` folds the list with.
 */

import { describe, expect, it } from "vitest";
import { WinnowStore } from "./store";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import { BUILTIN_FILTERS, builtinFilter, NEUTRAL_SIGNALS, type FilterId } from "../model/signals";
import { buildPills } from "../../ui/rail";
import { countFacets } from "../classify/filters";
import type { Email } from "../model/email";
import type { UserProfile } from "../model/profile";

function demoStore(filters: readonly FilterId[] = []) {
  const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
  store.attach({ onPersist: () => undefined });
  for (const filter of filters) store.toggleFilter(filter);
  return store;
}

function pillsOf(store: WinnowStore) {
  const view = store.view;
  return buildPills(view.rail, view.railCounts, view.profile.topSenders, view.railSenderCounts, store.getSnapshot().activeFilters, view.railFacets);
}

describe("Action needed: the pill and the masthead agree", () => {
  it("demo, Action needed on: the pill's number is the masthead's (the list's rows)", () => {
    const store = demoStore([builtinFilter("needs_action")]);
    const rows = store.view.threads.length;
    // The demo has a multi-message thread under Action needed, which is what split them.
    expect(store.view.emails.length).toBeGreaterThan(rows);
    const pill = pillsOf(store).find((p) => p.id.kind === "builtin" && p.id.id === "needs_action");
    expect(pill?.count).toBe(rows);
    expect(store.view.railFacets?.total).toBe(rows);
  });

  it("demo, nothing on: Action needed's plain number is the rows tapping it lists", () => {
    const pill = pillsOf(demoStore()).find((p) => p.id.kind === "builtin" && p.id.id === "needs_action");
    expect(pill?.count).toBe(demoStore([builtinFilter("needs_action")]).view.threads.length);
  });

  it("countFacets counts a thread once however many of its messages match", () => {
    const base = DEMO_EMAILS[0] as Email;
    const thread: Email[] = [0, 1, 2].map((i) => ({
      ...base,
      id: 9_000 + i,
      gmailId: `t-${i}`,
      threadId: "one-thread",
      receivedAt: base.receivedAt + i,
    }));
    const single: Email = { ...base, id: 9_100, gmailId: "solo", threadId: undefined };
    const emails = [...thread, single];
    const signals = new Map(emails.map((email) => [email.id, NEUTRAL_SIGNALS]));
    const profile = demoStore().view.profile as UserProfile;
    const facets = countFacets(emails, signals, profile, [], undefined, true)!;
    expect(facets.total).toBe(2);
    expect(facets.senders.get(base.sender.toLowerCase())).toBe(2);
    for (const id of BUILTIN_FILTERS) expect(facets.builtin.get(id) ?? 0).toBeLessThanOrEqual(2);
  });
});

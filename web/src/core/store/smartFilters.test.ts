/**
 * The store's side of "Change smart filters…": a correction moves the message at once,
 * teaches the sender rule, persists locally, explains itself, resets, and never outlives
 * the account it was made in.
 */

import { describe, expect, it } from "vitest";
import { WinnowStore, type MailBackend, type PersistPatch } from "./store";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import { hashId } from "../model/ids";
import { builtinFilter } from "../model/signals";
import { FilterLearning } from "../learn/filterLearning";

const MISSED = hashId("demo-missed-delivery-1");
const SIBLING = hashId("demo-missed-delivery-2");

function demoStore(patches: PersistPatch[] = []) {
  const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
  store.attach({ onPersist: (patch) => patches.push(patch) });
  return store;
}

const inDeliveries = (store: WinnowStore, id: number) =>
  store.smartFilterMembership([id]).get("shipping") === "all";

function backend(): MailBackend {
  return {
    async sync() {
      return { emails: [], failed: 0, truncated: false };
    },
    async toggleStar() {},
    async moveToMailbox() {},
    async setRead() {},
    async deletePermanently() {},
    async sendReply() {},
    async fetchBody() {
      return undefined;
    },
    async fetchAttachment() {
      return { bytes: new Uint8Array(), filename: "a", mimeType: "application/octet-stream" };
    },
  } as MailBackend;
}

describe("Change smart filters…", () => {
  it("has a demo delivery the built-in rules miss", () => {
    const store = demoStore();
    expect(inDeliveries(store, MISSED)).toBe(false);
    expect(inDeliveries(store, SIBLING)).toBe(false);
    expect(store.builtInFilter(MISSED, "shipping")).toBe(false);
  });

  it("moves the message at once and its sibling by the sender rule", () => {
    const store = demoStore();
    const before = store.view.inboxCounts.get("shipping") ?? 0;
    store.changeSmartFilters([MISSED], [{ filter: "shipping", into: true }]);
    expect(inDeliveries(store, MISSED)).toBe(true);
    expect(inDeliveries(store, SIBLING)).toBe(true);
    expect(store.view.inboxCounts.get("shipping")).toBe(before + 2);

    store.toggleFilter(builtinFilter("shipping"));
    const listed = store.view.emails.map((email) => email.id);
    expect(listed).toContain(MISSED);
    expect(listed).toContain(SIBLING);
  });

  it("explains itself in one plain line per filter, with no scores", () => {
    const store = demoStore();
    store.changeSmartFilters([MISSED], [{ filter: "shipping", into: true }]);
    const mine = store.explainSmartFilters(MISSED).find((line) => line.filter === "shipping");
    const sibling = store.explainSmartFilters(SIBLING).find((line) => line.filter === "shipping");
    expect(mine?.line).toBe("In Deliveries because: you put it here");
    expect(sibling?.line).toBe("In Deliveries because: from evri.com, has an Evri tracking number, you moved 1 email here");
  });

  it("takes a message out of a filter, and records multiselect corrections per message", () => {
    const store = demoStore();
    const shipped = hashId("demo-shipping-1");
    const other = hashId("demo-shipping-2");
    expect(inDeliveries(store, shipped)).toBe(true);
    store.changeSmartFilters([shipped, other], [{ filter: "shipping", into: false }]);
    expect(inDeliveries(store, shipped)).toBe(false);
    expect(inDeliveries(store, other)).toBe(false);
    expect(store.getSnapshot().filterLearning.correctionCount("shipping")).toBe(2);
    expect(store.smartFilterMembership([shipped, MISSED]).get("shipping")).toBe("none");
  });

  it("persists a versioned local snapshot on every change", () => {
    const patches: PersistPatch[] = [];
    const store = demoStore(patches);
    store.changeSmartFilters([MISSED], [{ filter: "shipping", into: true }]);
    const last = patches.filter((patch) => patch.filterLearning).pop()?.filterLearning;
    expect(last?.version).toBe(1);
    expect(last?.corrections).toHaveLength(1);
    expect(last?.corrections[0]).toMatchObject({ message: "demo-missed-delivery-1", filter: "shipping", into: true, domain: "evri.com" });

    const restored = demoStore();
    restored.restoreState({ filterLearning: last });
    expect(inDeliveries(restored, SIBLING)).toBe(true);
  });

  it("removes a sender rule from Settings without moving the corrected message", () => {
    const store = demoStore();
    store.changeSmartFilters([MISSED], [{ filter: "shipping", into: true }]);
    expect(store.getSnapshot().filterLearning.senderRules()).toHaveLength(1);
    store.removeFilterSenderRule("shipping", "evri.com");
    expect(store.getSnapshot().filterLearning.senderRules()).toEqual([]);
    expect(inDeliveries(store, MISSED)).toBe(true);
  });

  it("resets one filter or everything", () => {
    const store = demoStore();
    store.changeSmartFilters([MISSED], [{ filter: "shipping", into: true }, { filter: "important", into: true }]);
    store.resetFilterLearning("shipping");
    expect(inDeliveries(store, MISSED)).toBe(false);
    expect(store.getSnapshot().filterLearning.correctionCount("important")).toBe(1);
    store.resetFilterLearning();
    expect(store.getSnapshot().filterLearning.isEmpty).toBe(true);
  });

  it("is cleared on sign-out", async () => {
    const patches: PersistPatch[] = [];
    const store = demoStore(patches);
    store.changeSmartFilters([MISSED], [{ filter: "shipping", into: true }]);
    await store.signOut();
    expect(store.getSnapshot().filterLearning.isEmpty).toBe(true);
    expect(patches.at(-1)?.filterLearning?.corrections).toEqual([]);
  });

  it("is dropped when a different account connects, and kept for the same one", async () => {
    const store = demoStore();
    store.restoreState({
      filterLearning: FilterLearning.empty("ada@example.org")
        .record(DEMO_EMAILS.find((email) => email.id === MISSED)!, "shipping", true, 1)
        .toSnapshot(),
    });
    await store.connect(backend(), { email: "ada@example.org" });
    expect(store.getSnapshot().filterLearning.isEmpty).toBe(false);
    await store.connect(backend(), { email: "grace@example.org" });
    expect(store.getSnapshot().filterLearning.isEmpty).toBe(true);
    expect(store.getSnapshot().filterLearning.owner).toBe("grace@example.org");
  });

  it("drops the demo's corrections when a real account connects", async () => {
    const store = demoStore();
    store.changeSmartFilters([MISSED], [{ filter: "shipping", into: true }]);
    expect(store.getSnapshot().filterLearning.owner).not.toBeNull();
    await store.connect(backend(), { email: "ada@example.org" });
    expect(store.getSnapshot().filterLearning.isEmpty).toBe(true);
  });
});

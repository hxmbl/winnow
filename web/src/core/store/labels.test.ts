/**
 * "Label as…" in the store: the demo's seeded labels, making one, and applying a change
 * optimistically with a rollback when Gmail refuses it.
 */

import { describe, expect, it, vi } from "vitest";
import { WinnowStore, type MailBackend } from "./store";
import { DEMO_EMAILS, DEMO_LABELS } from "../data/demo";
import type { UserLabel } from "../mail/labels";

function demoStore() {
  return new WinnowStore({ seed: [...DEMO_EMAILS], seedLabels: DEMO_LABELS });
}

/** A backend with just the label verbs; the rest is never reached by these tests. */
function labelBackend(over: Partial<MailBackend> = {}): MailBackend {
  return {
    listLabels: async () => [
      { id: "Label_9", name: "zeta" },
      { id: "Label_8", name: "Alpha" },
    ],
    createLabel: async (name: string) => ({ id: "Label_10", name }),
    modifyLabels: async () => undefined,
    ...over,
  } as unknown as MailBackend;
}

const labelsOf = (store: WinnowStore, id: number) => store.getSnapshot().all.find((email) => email.id === id)?.labels;

describe("labels in the demo", () => {
  it("starts with the demo's labels, sorted by name", () => {
    expect(demoStore().getSnapshot().userLabels.map((label) => label.name)).toEqual([
      "Family",
      "Receipts",
      "Travel",
      "Work/Northwind",
    ]);
  });

  it("seeds some messages with labels", () => {
    expect(DEMO_EMAILS.some((email) => email.labels?.includes("Label_1"))).toBe(true);
  });

  it("applies a change to every target at once", () => {
    const store = demoStore();
    const [a, b] = store.getSnapshot().all;
    store.applyLabels([a!.id, b!.id], ["Label_4"], []);
    expect(labelsOf(store, a!.id)).toContain("Label_4");
    expect(labelsOf(store, b!.id)).toContain("Label_4");
    store.applyLabels([a!.id], [], ["Label_4"]);
    expect(labelsOf(store, a!.id)).not.toContain("Label_4");
    expect(labelsOf(store, b!.id)).toContain("Label_4");
  });

  it("makes a new label on this device with the next free id", async () => {
    const store = demoStore();
    const made = await store.createLabel("  Hiring ");
    expect(made).toEqual({ id: "Label_5", name: "Hiring" });
    expect(store.getSnapshot().userLabels.map((label) => label.id)).toContain("Label_5");
  });
});

describe("labels with Gmail", () => {
  it("lists the account's labels when asked, not before", async () => {
    const listLabels = vi.fn(
      async (): Promise<UserLabel[]> => [
        { id: "Label_9", name: "zeta" },
        { id: "Label_8", name: "Alpha" },
      ],
    );
    const store = new WinnowStore({ backend: labelBackend({ listLabels }) });
    expect(store.getSnapshot().userLabels).toEqual([]);
    expect(listLabels).not.toHaveBeenCalled();
    await store.loadLabels();
    expect(store.getSnapshot().userLabels.map((label) => label.name)).toEqual(["Alpha", "zeta"]);
  });

  it("says so when the labels cannot be listed", async () => {
    const store = new WinnowStore({ backend: labelBackend({ listLabels: async () => Promise.reject(new Error("offline")) }) });
    await store.loadLabels();
    expect(store.getSnapshot().notice).toMatch(/Couldn't list your labels: offline/);
    expect(store.getSnapshot().labelsLoading).toBe(false);
  });

  it("sends one call for the whole selection", () => {
    const modifyLabels = vi.fn(async () => undefined);
    const store = new WinnowStore({ seed: [...DEMO_EMAILS], backend: labelBackend({ modifyLabels }) });
    const ids = store.getSnapshot().all.slice(0, 3).map((email) => email.id);
    store.applyLabels(ids, ["Label_1"], ["Label_2"]);
    expect(modifyLabels).toHaveBeenCalledTimes(1);
    expect(modifyLabels).toHaveBeenCalledWith(ids, ["Label_1"], ["Label_2"]);
  });

  it("puts every message back as it was when Gmail refuses", async () => {
    const store = new WinnowStore({
      seed: [...DEMO_EMAILS],
      backend: labelBackend({ modifyLabels: async () => Promise.reject(new Error("Invalid label")) }),
    });
    const labelled = store.getSnapshot().all.find((email) => email.labels?.length)!;
    const plain = store.getSnapshot().all.find((email) => !email.labels)!;
    store.applyLabels([labelled.id, plain.id], ["Label_3"], [labelled.labels![0]!]);
    expect(labelsOf(store, plain.id)).toEqual(["Label_3"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(labelsOf(store, labelled.id)).toEqual(labelled.labels);
    expect(labelsOf(store, plain.id)).toBeUndefined();
    expect(store.getSnapshot().error).toBe("Invalid label");
  });

  it("adds a made label to the list", async () => {
    const store = new WinnowStore({ backend: labelBackend() });
    await store.createLabel("Family");
    expect(store.getSnapshot().userLabels).toEqual([{ id: "Label_10", name: "Family" }]);
  });
});

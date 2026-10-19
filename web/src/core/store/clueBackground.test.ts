/**
 * The store's clue background (`clueBackground`), which only learning reads: not built
 * while nothing has been learned, and kept while the inbox holds the same messages.
 */

import { describe, expect, it } from "vitest";
import { WinnowStore } from "./store";
import { EMPTY_BACKGROUND, type ClueBackground } from "../learn/filterLearning";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";

function background(store: WinnowStore): ClueBackground | undefined {
  // Reading the derived view runs the inbox analysis; the cache is private.
  void store.getSnapshot().view;
  return (store as unknown as { inboxCache: { background: ClueBackground } | null }).inboxCache?.background;
}

describe("the clue background", () => {
  it("is not built while the learning model is empty", () => {
    const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
    expect(store.getSnapshot().filterLearning.isEmpty).toBe(true);
    expect(background(store)).toBe(EMPTY_BACKGROUND);
    const row = store.getSnapshot().view.threads[0].representative;
    store.toggleStar(row.id);
    expect(background(store)).toBe(EMPTY_BACKGROUND);
  });

  it("is built once something is learned, and rebuilt only when the inbox changes", () => {
    const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
    const inbox = store.getSnapshot().all.filter((email) => email.mailbox === "inbox");
    store.changeSmartFilters([inbox[0].id], [{ filter: "shipping", into: true }]);
    expect(store.getSnapshot().filterLearning.isEmpty).toBe(false);
    const first = background(store)!;
    expect(first).not.toBe(EMPTY_BACKGROUND);
    expect(first.size).toBe(inbox.length);
    // A second correction changes the model, not the inbox: the same background.
    store.changeSmartFilters([inbox[1].id], [{ filter: "shipping", into: true }]);
    expect(background(store)).toBe(first);
    // Archiving changes the inbox: a new one, one message smaller.
    store.archive(inbox[2].id);
    const after = background(store)!;
    expect(after).not.toBe(first);
    expect(after.size).toBe(inbox.length - 1);
  });
});

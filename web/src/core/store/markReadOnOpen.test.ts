/**
 * Mark as read when opened: every route into the reader reads the message (and the rest
 * of its conversation), through the same optimistic `setRead` the toggle uses, with no
 * undo offer. Checking rows, searching and the switch being off read nothing.
 */

import { describe, expect, it, vi } from "vitest";
import { WinnowStore } from "./store";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import { DEFAULT_PREFERENCES } from "./store";
import { revivePreferences } from "./preferences";
import { builtinFilter } from "../model/signals";

function demoStore() {
  return new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
}

/** A backend that records `setRead` and answers every other call with nothing. */
function withBackend(store: WinnowStore) {
  const setRead = vi.fn(async () => undefined);
  const backend = new Proxy({ setRead } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : undefined),
  });
  store.attach({ backend } as unknown as Parameters<WinnowStore["attach"]>[0]);
  return setRead;
}

function unreadRow(store: WinnowStore, single = true, from = 0): number {
  const threads = store.view.threads;
  for (let i = from; i < threads.length; i += 1) {
    const row = threads[i]!;
    if (row.unread && (!single || row.messageCount === 1)) return i;
  }
  throw new Error("demo has no unread row");
}

const isUnread = (store: WinnowStore, id: number) =>
  store.getSnapshot().all.find((e) => e.id === id)!.unread;

describe("mark as read when opened", () => {
  it("is on by default and survives a restart only as a boolean", () => {
    expect(DEFAULT_PREFERENCES.markReadOnOpen).toBe(true);
    expect(revivePreferences({ markReadOnOpen: false })).toMatchObject({ markReadOnOpen: false });
    expect(revivePreferences({ markReadOnOpen: "no" })?.markReadOnOpen).toBeUndefined();
  });

  it("a click reads the message, optimistically, through the backend, with no undo", () => {
    const store = demoStore();
    const setRead = withBackend(store);
    const index = unreadRow(store);
    const id = store.view.threads[index]!.representative.id;
    store.openRow(index);
    expect(isUnread(store, id)).toBe(false);
    expect(setRead).toHaveBeenCalledWith(id, true);
    expect(store.getSnapshot().undo).toBeNull();
  });

  it("Enter, j/k and a deep link read what they open", () => {
    const store = demoStore();
    const first = unreadRow(store);
    // `j` from no cursor opens row 0; walk to the first unread row.
    for (let i = 0; i <= first; i += 1) store.moveCursor(1);
    expect(isUnread(store, store.view.threads[first]!.representative.id)).toBe(false);

    const next = unreadRow(store, true, first + 1);
    store.closeReader();
    store.openRow(next - 1);
    store.closeReader();
    store.openCursor(); // Enter on the cursor row
    store.moveCursor(1);
    expect(isUnread(store, store.view.threads[next]!.representative.id)).toBe(false);

    const linked = unreadRow(store, true, next + 1);
    const linkedId = store.view.threads[linked]!.representative.id;
    store.focusMessage(linkedId);
    expect(isUnread(store, linkedId)).toBe(false);
  });

  it("opening a thread reads every unread message in it", () => {
    const store = demoStore();
    const index = store.view.threads.findIndex((row) => row.messageCount > 1 && row.unread);
    expect(index).toBeGreaterThanOrEqual(0);
    const threadId = store.view.threads[index]!.representative.threadId;
    const inThread = () => store.getSnapshot().all.filter((e) => e.threadId === threadId);
    // Make sure more than the newest is unread, so the test means something.
    for (const email of inThread()) store.setRead(email.id, false);
    expect(inThread().filter((e) => e.unread).length).toBeGreaterThan(1);

    store.openRow(index);
    expect(inThread().every((e) => !e.unread)).toBe(true);
    expect(store.view.threads[index]!.unread).toBe(false);
  });

  it("with the switch off, opening keeps today's behaviour", () => {
    const store = demoStore();
    const setRead = withBackend(store);
    store.setPreferences({ markReadOnOpen: false });
    const index = unreadRow(store);
    const id = store.view.threads[index]!.representative.id;
    store.openRow(index);
    store.moveCursor(1);
    store.moveCursor(-1);
    store.focusMessage(id);
    expect(isUnread(store, id)).toBe(true);
    expect(setRead).not.toHaveBeenCalled();
  });

  it("marking the open message unread does not loop back to read, and re-opening reads it", () => {
    const store = demoStore();
    const index = unreadRow(store);
    const id = store.view.threads[index]!.representative.id;
    store.openRow(index);
    expect(isUnread(store, id)).toBe(false);

    store.markUnreadAndMoveOn(id);
    expect(isUnread(store, id)).toBe(true);
    expect(store.getSnapshot().selectedId).not.toBe(id);

    // Later, a fresh open.
    store.openRow(store.view.threads.findIndex((row) => row.representative.id === id));
    expect(isUnread(store, id)).toBe(false);
  });

  it("on a phone, marking unread goes back to the list and stays unread", () => {
    const store = demoStore();
    const index = unreadRow(store);
    const id = store.view.threads[index]!.representative.id;
    store.openRow(index);
    store.markUnreadAndMoveOn(id, { phone: true });
    expect(store.getSnapshot().selectedId).toBeNull();
    expect(isUnread(store, id)).toBe(true);
  });

  it("checking rows, other batch verbs, and searching read nothing", () => {
    const store = demoStore();
    const setRead = withBackend(store);
    const unread = store.view.threads.filter((row) => row.unread).slice(0, 3);
    const ids = unread.map((row) => row.representative.id);
    // Select mode is UI state: checking rows never reaches the store. What does reach it
    // from a selection is a batch verb.
    store.toggleStar(ids[0]!);
    store.muteSender(store.getSnapshot().all.find((e) => e.id === ids[1])!.sender);
    // A search highlights matches without opening any of them.
    store.setSearchQuery("migration");
    expect(ids.every((id) => isUnread(store, id))).toBe(true);
    expect(setRead).not.toHaveBeenCalled();
    expect(store.getSnapshot().selectedId).toBeNull();
  });

  it("under the Unread filter, j after an open does not skip the row that slid up", () => {
    const store = demoStore();
    store.toggleFilter(builtinFilter("unread"));
    const rows = store.view.threads.map((row) => row.representative.id);
    expect(rows.length).toBeGreaterThan(2);
    store.openRow(0);
    // Read now, so it left the filtered list; the reader keeps it.
    expect(store.getSnapshot().selectedId).toBe(rows[0]);
    store.moveCursor(1);
    expect(store.getSnapshot().selectedId).toBe(rows[1]);
  });
});

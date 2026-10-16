/**
 * The store's side of the PR #10 list work: navigation-only reveal, marking the open
 * message unread (and moving on), batch actions for a multi-row selection, and the
 * sender verbs the avatar menu and the row context menu call.
 */

import { describe, expect, it } from "vitest";
import { NO_CURSOR, WinnowStore, type PlatformBridge } from "./store";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import { revivePreferences } from "./preferences";

function demoStore() {
  return new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
}

function readRowIndex(store: WinnowStore, from = 0): number {
  const threads = store.view.threads;
  for (let i = from; i < threads.length; i += 1) {
    if (!threads[i]!.representative.unread) return i;
  }
  throw new Error("demo has no read row");
}

describe("revealing the cursor's row", () => {
  it("bumps on keyboard navigation", () => {
    const store = demoStore();
    const before = store.getSnapshot().revealSeq;
    store.moveCursor(1);
    expect(store.getSnapshot().revealSeq).toBe(before + 1);
    store.moveCursor(1);
    expect(store.getSnapshot().revealSeq).toBe(before + 2);
  });

  it("does not bump on a click, a re-derive or a data change", () => {
    const store = demoStore();
    const before = store.getSnapshot().revealSeq;
    store.openRow(4);
    store.toggleStar(store.view.threads[0]!.representative.id);
    store.setSortBy("date");
    store.replaceAll([...DEMO_EMAILS]);
    expect(store.getSnapshot().revealSeq).toBe(before);
  });

  it("bumps when a message is followed by id", () => {
    const store = demoStore();
    const before = store.getSnapshot().revealSeq;
    store.focusMessage(store.view.threads[6]!.representative.id);
    expect(store.getSnapshot().revealSeq).toBe(before + 1);
  });
});

describe("marking the open message unread", () => {
  it("desktop: advances to the next row and leaves the message unread", () => {
    const store = demoStore();
    const index = readRowIndex(store);
    const id = store.view.threads[index]!.representative.id;
    const nextId = store.view.threads[index + 1]!.representative.id;
    store.openRow(index);
    const seq = store.getSnapshot().revealSeq;

    store.markUnreadAndMoveOn(id);

    const snap = store.getSnapshot();
    expect(snap.all.find((e) => e.id === id)!.unread).toBe(true);
    expect(snap.selectedId).toBe(nextId);
    expect(snap.cursorIndex).toBe(index + 1);
    expect(snap.revealSeq).toBe(seq + 1);
  });

  it("desktop: closes onto the empty pane when there is no next row", () => {
    const store = demoStore();
    const last = store.view.threads.length - 1;
    const id = store.view.threads[last]!.representative.id;
    store.setRead(id, true);
    store.openRow(last);

    store.markUnreadAndMoveOn(id);

    expect(store.getSnapshot().selectedId).toBeNull();
    expect(store.getSnapshot().all.find((e) => e.id === id)!.unread).toBe(true);
  });

  it("phone: returns to the list with no current row", () => {
    const store = demoStore();
    const index = readRowIndex(store);
    const id = store.view.threads[index]!.representative.id;
    store.openRow(index);

    store.markUnreadAndMoveOn(id, { phone: true });

    const snap = store.getSnapshot();
    expect(snap.selectedId).toBeNull();
    expect(snap.cursorIndex).toBe(NO_CURSOR);
    expect(snap.all.find((e) => e.id === id)!.unread).toBe(true);
  });

  it("moving on never marks the unread one read again; only going back to it does", () => {
    const store = demoStore();
    const index = readRowIndex(store);
    const id = store.view.threads[index]!.representative.id;
    store.openRow(index);
    store.markUnreadAndMoveOn(id);
    store.moveCursor(1);
    expect(store.getSnapshot().all.find((e) => e.id === id)!.unread).toBe(true);
    // Back onto it is a new open, and an open reads it.
    store.moveCursor(-2);
    expect(store.getSnapshot().selectedId).toBe(id);
    expect(store.getSnapshot().all.find((e) => e.id === id)!.unread).toBe(false);
  });

  it("with read-on-open off, nothing it lands on is marked read", () => {
    const store = demoStore();
    store.setPreferences({ markReadOnOpen: false });
    const index = readRowIndex(store);
    const id = store.view.threads[index]!.representative.id;
    store.openRow(index);
    store.markUnreadAndMoveOn(id);
    store.moveCursor(1);
    store.moveCursor(-2);
    store.closeReader();
    expect(store.getSnapshot().all.find((e) => e.id === id)!.unread).toBe(true);
  });

  it("only marks a message that is not open, and keeps the reader where it is", () => {
    const store = demoStore();
    store.openRow(0);
    const open = store.getSnapshot().selectedId;
    const other = store.view.threads[readRowIndex(store, 1)]!.representative.id;
    store.markUnreadAndMoveOn(other);
    expect(store.getSnapshot().selectedId).toBe(open);
    expect(store.getSnapshot().all.find((e) => e.id === other)!.unread).toBe(true);
  });
});

describe("batch actions", () => {
  it("archives every selected message", () => {
    const store = demoStore();
    const ids = store.view.threads.slice(0, 3).map((row) => row.representative.id);
    store.archiveMany(ids);
    for (const id of ids) {
      expect(store.getSnapshot().all.find((e) => e.id === id)!.mailbox).toBe("archive");
    }
  });

  it("moves every selected message to the bin", () => {
    const store = demoStore();
    const ids = store.view.threads.slice(2, 5).map((row) => row.representative.id);
    store.trashMany(ids);
    for (const id of ids) {
      expect(store.getSnapshot().all.find((e) => e.id === id)!.mailbox).toBe("trash");
    }
  });

  it("marks read and unread outright, not as a toggle", () => {
    const store = demoStore();
    const ids = store.view.threads.slice(0, 6).map((row) => row.representative.id);
    store.setReadMany(ids, true);
    expect(ids.every((id) => !store.getSnapshot().all.find((e) => e.id === id)!.unread)).toBe(true);
    store.setReadMany(ids, true);
    expect(ids.every((id) => !store.getSnapshot().all.find((e) => e.id === id)!.unread)).toBe(true);
    store.setReadMany(ids, false);
    expect(ids.every((id) => store.getSnapshot().all.find((e) => e.id === id)!.unread)).toBe(true);
  });

  it("moves every selected message to a named mailbox", () => {
    const store = demoStore();
    const ids = store.view.threads.slice(0, 2).map((row) => row.representative.id);
    store.moveMany(ids, "spam");
    for (const id of ids) {
      expect(store.getSnapshot().all.find((e) => e.id === id)!.mailbox).toBe("spam");
    }
  });
});

describe("sender verbs", () => {
  it("shows all mail from a sender as the only filter, with the search cleared", () => {
    const store = demoStore();
    const sender = store.view.threads[0]!.representative.sender;
    store.setSearchQuery("zzz");
    store.showSender(sender);
    const snap = store.getSnapshot();
    expect(snap.searchQuery).toBe("");
    expect(snap.activeFilters).toEqual([{ kind: "sender", sender }]);
    expect(store.view.threads.every((row) => row.representative.sender === sender)).toBe(true);
  });

  it("searches for a subject without its reply prefixes", () => {
    const store = demoStore();
    store.searchSubject("Re: Fwd: RE: Quarterly plan");
    expect(store.getSnapshot().searchQuery).toBe("Quarterly plan");
  });

  it("mutes and unmutes a sender, case-insensitively, and persists it", () => {
    const persisted: unknown[] = [];
    const store = demoStore();
    store.attach({ onPersist: (patch) => persisted.push(patch) } as Parameters<WinnowStore["attach"]>[0]);
    store.muteSender("News@Example.com");
    store.muteSender("news@example.com");
    expect(store.getSnapshot().preferences.mutedSenders).toEqual(["News@Example.com"]);
    expect(store.isSenderMuted("NEWS@example.com")).toBe(true);
    expect(persisted.length).toBeGreaterThan(0);
    store.unmuteSender("news@EXAMPLE.com");
    expect(store.getSnapshot().preferences.mutedSenders).toEqual([]);
  });

  it("leaves a muted sender's mail out of the badge", async () => {
    const badges: number[] = [];
    const platform: PlatformBridge = {
      async notifyNewMail() {},
      async setUnreadBadge(count) {
        badges.push(count);
      },
      async setBackgroundSync() {},
    };
    const store = demoStore();
    store.attach({ platform } as Parameters<WinnowStore["attach"]>[0]);
    const unreadRow = store.view.threads.find((row) => row.representative.unread)!;
    const sender = unreadRow.representative.sender;
    const fromSender = store.view.emails.filter(
      (email) => email.unread && email.sender.toLowerCase() === sender.toLowerCase(),
    ).length;
    const before = store.badgeCount();
    store.muteSender(sender);
    expect(store.badgeCount()).toBe(before - fromSender);
    await Promise.resolve();
    expect(badges.at(-1)).toBe(before - fromSender);
  });

  it("revives muted senders from storage, dropping junk", () => {
    expect(revivePreferences({ mutedSenders: ["a@b.c", 4, "nope"] })?.mutedSenders).toEqual(["a@b.c"]);
  });
});

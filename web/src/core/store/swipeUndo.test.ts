/**
 * The store's side of the phone's swipe actions: Trash and Restore with Undo on the
 * strip, a draft discarded with Undo (Gmail's copy deleted only once the offer is let
 * go), and the setting that turns the gesture off.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, DRAFT_DISCARD_UNDO_MS, WinnowStore, type MailBackend } from "./store";
import { revivePreferences } from "./preferences";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import type { Email, Mailbox } from "../model/email";

function demoStore() {
  return new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
}

function mail(id: number, mailbox: Mailbox, unread = true): Email {
  return {
    id,
    gmailId: `g-${id}`,
    sender: `s${id}@example.com`,
    mailbox,
    receivedAt: 1_000 + id,
    subject: `Message ${id}`,
    body: "words",
    category: "primary",
    starred: false,
    unread,
    urgent: false,
    attachments: [],
  };
}

function draft(id: number, draftId: string): Email {
  return { ...mail(id, "drafts", false), gmailDraft: { id: draftId } };
}

function liveBackend(emails: Email[], drafts: Email[] = []) {
  const moves: [number, Mailbox][] = [];
  const deleted: string[] = [];
  const backend: MailBackend = {
    async sync() {
      return { emails: emails.map((email) => ({ ...email })), failed: 0, truncated: false };
    },
    async toggleStar() {},
    async moveToMailbox(id, mailbox) {
      moves.push([id, mailbox]);
    },
    async setRead() {},
    async deletePermanently() {},
    async sendReply() {},
    async fetchBody() {
      return undefined;
    },
    async fetchAttachment() {
      return { bytes: new Uint8Array(), filename: "a", mimeType: "application/octet-stream" };
    },
    async listDrafts() {
      return drafts.map((row) => ({ ...row }));
    },
    drafts: {
      async create() {
        return "new";
      },
      async update(id) {
        return id;
      },
      async delete(id) {
        deleted.push(id);
      },
    },
  };
  return { backend, moves, deleted };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("swipe to Trash", () => {
  it("moves the message to the Trash and offers Undo", () => {
    const store = demoStore();
    const row = store.view.threads.find((candidate) => candidate.representative.unread)!.representative;
    store.moveWithUndo(row.id, "trash");
    const snap = store.getSnapshot();
    expect(snap.all.find((email) => email.id === row.id)?.mailbox).toBe("trash");
    expect(snap.view.threads.some((candidate) => candidate.representative.id === row.id)).toBe(false);
    expect(snap.undo).toMatchObject({ label: "Moved to Trash." });
  });

  it("Undo puts the mailbox and the unread flag back, and clears the strip", () => {
    const store = demoStore();
    const row = store.view.threads.find((candidate) => candidate.representative.unread)!.representative;
    store.moveWithUndo(row.id, "trash");
    store.undoLast();
    const back = store.getSnapshot().all.find((email) => email.id === row.id)!;
    expect(back.mailbox).toBe("inbox");
    expect(back.unread).toBe(true);
    expect(store.getSnapshot().undo).toBeNull();
    expect(store.getSnapshot().view.threads.some((candidate) => candidate.representative.id === row.id)).toBe(true);
  });

  it("goes through Gmail both ways, and restores Sent mail by taking Trash off", async () => {
    const live = liveBackend([mail(1, "inbox"), mail(2, "sent", false)]);
    const store = new WinnowStore({ backend: live.backend });
    await store.connect(live.backend, { email: "me@example.com" });
    store.moveWithUndo(1, "trash");
    store.undoLast();
    store.moveWithUndo(2, "trash");
    store.undoLast();
    await flush();
    expect(live.moves).toEqual([
      [1, "trash"],
      [1, "inbox"],
      [2, "trash"],
      [2, "archive"],
    ]);
    expect(store.getSnapshot().all.find((email) => email.id === 2)?.mailbox).toBe("sent");
  });

  it("an Undo for mail that has moved on since does nothing", () => {
    const store = demoStore();
    const id = store.view.threads[0]!.representative.id;
    store.moveWithUndo(id, "trash");
    store.move(id, "spam");
    store.undoLast();
    expect(store.getSnapshot().all.find((email) => email.id === id)?.mailbox).toBe("spam");
  });

  it("restores from the Trash to the Inbox, with Undo back to the Trash", () => {
    const store = demoStore();
    store.setMailbox("trash");
    const id = store.view.threads[0]!.representative.id;
    store.moveWithUndo(id, "inbox");
    expect(store.getSnapshot().undo).toMatchObject({ label: "Moved to Inbox." });
    expect(store.getSnapshot().all.find((email) => email.id === id)?.mailbox).toBe("inbox");
    store.undoLast();
    expect(store.getSnapshot().all.find((email) => email.id === id)?.mailbox).toBe("trash");
  });

  it("the offer goes when the mailbox changes", () => {
    const store = demoStore();
    store.moveWithUndo(store.view.threads[0]!.representative.id, "trash");
    store.setMailbox("archive");
    expect(store.getSnapshot().undo).toBeNull();
  });
});

describe("swipe to discard a draft", () => {
  it("takes the row out now and deletes Gmail's copy only when the offer is let go", async () => {
    const live = liveBackend([mail(1, "inbox")], [draft(11, "r-1"), draft(12, "r-2")]);
    const store = new WinnowStore({ backend: live.backend });
    await store.connect(live.backend, { email: "me@example.com" });
    store.setMailbox("drafts");
    await store.refreshDrafts();
    store.discardDraftWithUndo(11);
    expect(store.getSnapshot().drafts.map((row) => row.id)).toEqual([12]);
    expect(store.getSnapshot().undo).toMatchObject({ label: "Draft discarded." });
    // A listing meanwhile does not bring it back.
    await store.refreshDrafts();
    expect(store.getSnapshot().drafts.map((row) => row.id)).toEqual([12]);
    await flush();
    expect(live.deleted).toEqual([]);
    store.dismissUndo();
    await flush();
    expect(live.deleted).toEqual(["r-1"]);
  });

  it("Undo puts the draft back and deletes nothing", async () => {
    const live = liveBackend([mail(1, "inbox")], [draft(11, "r-1")]);
    const store = new WinnowStore({ backend: live.backend });
    await store.connect(live.backend, { email: "me@example.com" });
    store.setMailbox("drafts");
    await store.refreshDrafts();
    store.discardDraftWithUndo(11);
    store.undoLast();
    await flush();
    expect(store.getSnapshot().drafts.map((row) => row.id)).toEqual([11]);
    expect(live.deleted).toEqual([]);
    // And the next offer letting go of nothing deletes nothing either.
    store.moveWithUndo(1, "trash");
    await flush();
    expect(live.deleted).toEqual([]);
  });

  it("a newer offer lets the discard go", async () => {
    const live = liveBackend([mail(1, "inbox")], [draft(11, "r-1")]);
    const store = new WinnowStore({ backend: live.backend });
    await store.connect(live.backend, { email: "me@example.com" });
    store.setMailbox("drafts");
    await store.refreshDrafts();
    store.discardDraftWithUndo(11);
    store.setMailbox("inbox");
    await flush();
    expect(live.deleted).toEqual(["r-1"]);
  });

  it("deletes on its own after the window, and the strip goes with it", async () => {
    vi.useFakeTimers();
    const live = liveBackend([mail(1, "inbox")], [draft(11, "r-1")]);
    const store = new WinnowStore({ backend: live.backend });
    await store.connect(live.backend, { email: "me@example.com" });
    store.setMailbox("drafts");
    await store.refreshDrafts();
    store.discardDraftWithUndo(11);
    vi.advanceTimersByTime(DRAFT_DISCARD_UNDO_MS + 1);
    await vi.runOnlyPendingTimersAsync();
    expect(live.deleted).toEqual(["r-1"]);
    expect(store.getSnapshot().undo).toBeNull();
  });

  it("sign-out keeps the draft rather than deleting it", async () => {
    const live = liveBackend([mail(1, "inbox")], [draft(11, "r-1")]);
    const store = new WinnowStore({ backend: live.backend });
    await store.connect(live.backend, { email: "me@example.com" });
    store.setMailbox("drafts");
    await store.refreshDrafts();
    store.discardDraftWithUndo(11);
    await store.signOut();
    await flush();
    expect(live.deleted).toEqual([]);
  });
});

describe("the Swipe actions setting", () => {
  it("is on by default and survives a restart", () => {
    expect(DEFAULT_PREFERENCES.swipeActions).toBe(true);
    expect(revivePreferences({ swipeActions: false })).toMatchObject({ swipeActions: false });
    expect(revivePreferences({ swipeActions: "off" })).not.toHaveProperty("swipeActions");
  });
});

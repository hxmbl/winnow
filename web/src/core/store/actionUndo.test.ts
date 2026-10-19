/**
 * Undo beyond the phone's swipes: archive and trash from the keyboard, the reader and
 * the row menu, a multi-select batch with one offer for the whole batch, and Move. The
 * same semantics as the swipe (`swipeUndo.test.ts`): no timer, newest wins, each Undo
 * takes back only its own action, through Gmail both ways.
 */

import { describe, expect, it } from "vitest";
import { WinnowStore, undoLabel, type MailBackend } from "./store";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import type { Email, Mailbox } from "../model/email";

function mail(id: number, mailbox: Mailbox, unread = true, sender = `s${id}@example.com`): Email {
  return {
    id,
    gmailId: `g-${id}`,
    sender,
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

function liveBackend(emails: Email[], { failMoves = false } = {}) {
  const moves: [number, Mailbox][] = [];
  const backend: MailBackend = {
    async sync() {
      return { emails: emails.map((email) => ({ ...email })), failed: 0, truncated: false };
    },
    async toggleStar() {},
    async moveToMailbox(id, mailbox) {
      moves.push([id, mailbox]);
      if (failMoves) throw new Error("offline");
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
  };
  return { backend, moves };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const where = (store: WinnowStore, id: number) => store.getSnapshot().all.find((email) => email.id === id);

async function live(emails: Email[], options?: { failMoves?: boolean }) {
  const fake = liveBackend(emails, options);
  const store = new WinnowStore({ backend: fake.backend });
  await store.connect(fake.backend, { email: "me@example.com" });
  return { store, moves: fake.moves };
}

describe("the label", () => {
  it("is the swipe's wording, with a count for a batch", () => {
    expect(undoLabel(["trash"])).toBe("Moved to Trash.");
    expect(undoLabel(["archive"])).toBe("Archived.");
    expect(undoLabel(["inbox"])).toBe("Moved to Inbox.");
    expect(undoLabel(["trash", "trash", "trash", "trash", "trash"])).toBe("Moved 5 to Trash.");
    expect(undoLabel(["archive", "archive"])).toBe("Archived 2.");
    expect(undoLabel(["spam", "spam"])).toBe("Moved 2 to Spam.");
    expect(undoLabel(["archive", "inbox"])).toBe("Moved 2.");
  });
});

describe("archive with Undo", () => {
  it("archives one message, says so, and Undo puts it back unread", async () => {
    const { store, moves } = await live([mail(1, "inbox"), mail(2, "inbox")]);
    store.archiveWithUndo([1]);
    expect(where(store, 1)?.mailbox).toBe("archive");
    expect(store.getSnapshot().undo).toMatchObject({ label: "Archived." });
    store.undoLast();
    await flush();
    expect(where(store, 1)).toMatchObject({ mailbox: "inbox", unread: true });
    expect(store.getSnapshot().undo).toBeNull();
    expect(moves).toEqual([
      [1, "archive"],
      [1, "inbox"],
    ]);
  });

  it("keeps archive's meaning per mailbox: back to the Inbox from the Archive, nothing from Sent", async () => {
    const { store } = await live([mail(1, "archive", false), mail(2, "sent", false)]);
    store.setMailbox("archive");
    store.archiveWithUndo([1]);
    expect(where(store, 1)?.mailbox).toBe("inbox");
    expect(store.getSnapshot().undo).toMatchObject({ label: "Moved to Inbox." });
    store.dismissUndo();
    store.setMailbox("sent");
    store.archiveWithUndo([2]);
    expect(where(store, 2)?.mailbox).toBe("sent");
    expect(store.getSnapshot().undo).toBeNull();
  });
});

describe("trash with Undo", () => {
  it("one message: Moved to Trash., Undo restores mailbox and unread through Gmail", async () => {
    const { store, moves } = await live([mail(1, "inbox"), mail(2, "inbox")]);
    store.trashWithUndo([1]);
    expect(where(store, 1)?.mailbox).toBe("trash");
    expect(store.getSnapshot().undo).toMatchObject({ label: "Moved to Trash." });
    store.undoLast();
    await flush();
    expect(where(store, 1)).toMatchObject({ mailbox: "inbox", unread: true });
    expect(moves).toEqual([
      [1, "trash"],
      [1, "inbox"],
    ]);
  });

  it("restores Sent mail by taking Trash off (archive at the API, Sent here)", async () => {
    const { store, moves } = await live([mail(1, "sent", false)]);
    store.setMailbox("sent");
    store.trashWithUndo([1]);
    store.undoLast();
    await flush();
    expect(where(store, 1)?.mailbox).toBe("sent");
    expect(moves.at(-1)).toEqual([1, "archive"]);
  });

  it("in the Trash deletes for good and offers nothing", () => {
    const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
    store.setMailbox("trash");
    const id = store.view.threads[0]!.representative.id;
    store.trashWithUndo([id]);
    expect(where(store, id)).toBeUndefined();
    expect(store.getSnapshot().undo).toBeNull();
  });
});

describe("a batch", () => {
  it("one offer covers the batch, and Undo takes back every message in it", async () => {
    const emails = [1, 2, 3, 4, 5, 6].map((id) => mail(id, "inbox", id % 2 === 0));
    const { store, moves } = await live(emails);
    store.trashWithUndo([1, 2, 3, 4, 5]);
    expect(store.getSnapshot().undo).toMatchObject({ label: "Moved 5 to Trash." });
    expect([1, 2, 3, 4, 5].every((id) => where(store, id)?.mailbox === "trash")).toBe(true);
    store.undoLast();
    await flush();
    for (const id of [1, 2, 3, 4, 5]) expect(where(store, id)).toMatchObject({ mailbox: "inbox", unread: id % 2 === 0 });
    expect(where(store, 6)?.mailbox).toBe("inbox");
    expect(moves.filter(([, to]) => to === "inbox").map(([id]) => id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("archives a batch as one notice", async () => {
    const { store } = await live([mail(1, "inbox"), mail(2, "inbox"), mail(3, "inbox")]);
    store.archiveWithUndo([1, 2, 3]);
    expect(store.getSnapshot().undo).toMatchObject({ label: "Archived 3." });
    store.undoLast();
    expect([1, 2, 3].every((id) => where(store, id)?.mailbox === "inbox")).toBe(true);
  });

  it("Move to a chosen mailbox, with Undo", async () => {
    const { store } = await live([mail(1, "inbox"), mail(2, "inbox")]);
    store.moveManyWithUndo([1, 2], "spam");
    expect(store.getSnapshot().undo).toMatchObject({ label: "Moved 2 to Spam." });
    store.undoLast();
    expect([1, 2].every((id) => where(store, id)?.mailbox === "inbox")).toBe(true);
  });

  it("Undo leaves alone a message that moved on since", async () => {
    const { store } = await live([mail(1, "inbox"), mail(2, "inbox")]);
    store.trashWithUndo([1, 2]);
    store.move(2, "spam");
    store.undoLast();
    expect(where(store, 1)?.mailbox).toBe("inbox");
    expect(where(store, 2)?.mailbox).toBe("spam");
  });

  it("takes back the sender trash marks only this action added", async () => {
    const shared = "same@example.com";
    const { store } = await live([mail(1, "inbox", true, shared), mail(2, "inbox", true, shared), mail(3, "inbox")]);
    store.trash(3);
    store.trashWithUndo([1, 2]);
    // Private, but it is the whole point of the check: the profile's trash bias.
    const marks = () => (store as unknown as { trashSenders: string[] }).trashSenders;
    expect(marks()).toEqual(expect.arrayContaining([shared, "s3@example.com"]));
    store.undoLast();
    expect(marks()).toEqual(["s3@example.com"]);
  });
});

describe("newest wins", () => {
  it("a second action replaces the first offer, and Undo takes back only the second", async () => {
    const { store } = await live([mail(1, "inbox"), mail(2, "inbox")]);
    store.archiveWithUndo([1]);
    store.trashWithUndo([2]);
    expect(store.getSnapshot().undo).toMatchObject({ label: "Moved to Trash." });
    store.undoLast();
    expect(where(store, 2)?.mailbox).toBe("inbox");
    expect(where(store, 1)?.mailbox).toBe("archive");
    expect(store.getSnapshot().undo).toBeNull();
  });

  it("there is no timer: the offer waits", async () => {
    const { store } = await live([mail(1, "inbox")]);
    store.trashWithUndo([1]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getSnapshot().undo).toMatchObject({ label: "Moved to Trash." });
  });

  it("a failed move rolls back on its own, and its Undo then does nothing", async () => {
    const { store, moves } = await live([mail(1, "inbox")], { failMoves: true });
    store.trashWithUndo([1]);
    await flush();
    expect(where(store, 1)?.mailbox).toBe("inbox");
    store.undoLast();
    await flush();
    expect(moves).toEqual([[1, "trash"]]);
  });
});

describe("drafts", () => {
  it("one draft discarded from the keyboard or reader is the swipe's discard, with Undo", async () => {
    const fake = liveBackend([mail(1, "inbox")]);
    const deleted: string[] = [];
    const drafts = [11, 12].map((id) => ({ ...mail(id, "drafts", false), gmailDraft: { id: `r-${id}` } }));
    const backend: MailBackend = {
      ...fake.backend,
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
    const store = new WinnowStore({ backend });
    await store.connect(backend, { email: "me@example.com" });
    store.setMailbox("drafts");
    await store.refreshDrafts();
    store.trashWithUndo([11]);
    expect(store.getSnapshot().drafts.map((row) => row.id)).toEqual([12]);
    expect(store.getSnapshot().undo).toMatchObject({ label: "Draft discarded." });
    store.undoLast();
    await flush();
    expect(store.getSnapshot().drafts.map((row) => row.id).sort()).toEqual([11, 12]);
    expect(deleted).toEqual([]);
  });
});

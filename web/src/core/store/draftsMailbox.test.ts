/**
 * The Drafts mailbox in the store.
 *
 * Pinned: drafts are their own list (a sync never drops them, and they are never mail
 * to anything that reads `all`); opening Drafts lists them, live only; delete in Drafts
 * discards through `drafts.delete` and puts the row back if that fails; a listing that
 * lands after sign-out is dropped; the demo shows its seeded drafts.
 */

import { describe, expect, it } from "vitest";
import { WinnowStore, type MailBackend } from "./store";
import { DEMO_DRAFTS, DEMO_EMAILS } from "../data/demo";
import type { Email } from "../model/email";

function draftRow(id: number, draftId: string, at = 1_000): Email {
  return {
    id,
    gmailId: `m-${draftId}`,
    sender: "me@example.com",
    mailbox: "drafts",
    receivedAt: at,
    subject: `Draft ${draftId}`,
    body: "words",
    category: "primary",
    starred: false,
    unread: false,
    urgent: false,
    attachments: [],
    gmailDraft: { id: draftId },
  };
}

function liveBackend(listing: () => Promise<Email[]>) {
  const deleted: string[] = [];
  let failDelete = false;
  let lists = 0;
  const backend: MailBackend = {
    async sync() {
      return { emails: [...DEMO_EMAILS], failed: 0, truncated: false };
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
    async listDrafts() {
      lists += 1;
      return listing();
    },
    drafts: {
      async create() {
        return "new";
      },
      async update(id) {
        return id;
      },
      async delete(id) {
        if (failDelete) throw new Error("offline");
        deleted.push(id);
      },
    },
  };
  return {
    backend,
    deleted,
    lists: () => lists,
    failDeletes: () => {
      failDelete = true;
    },
  };
}

describe("the Drafts mailbox", () => {
  it("shows the demo's seeded drafts, and only in Drafts", () => {
    const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedDrafts: DEMO_DRAFTS });
    expect(store.getSnapshot().view.threads.some((row) => row.representative.mailbox === "drafts")).toBe(false);
    store.setMailbox("drafts");
    const rows = store.getSnapshot().view.threads;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.representative.gmailDraft !== undefined)).toBe(true);
    // Never mail: nothing in `all` is a draft.
    expect(store.getSnapshot().all.some((email) => email.mailbox === "drafts")).toBe(false);
  });

  it("lists drafts when Drafts opens, and a sync does not drop them", async () => {
    const live = liveBackend(async () => [draftRow(11, "r-1"), draftRow(12, "r-2", 2_000)]);
    const store = new WinnowStore({ backend: live.backend });
    await store.connect(live.backend, { email: "me@example.com" });
    expect(live.lists()).toBe(0);
    store.setMailbox("drafts");
    await store.refreshDrafts();
    expect(live.lists()).toBe(1);
    expect(store.getSnapshot().view.threads.map((row) => row.representative.gmailDraft?.id).sort()).toEqual(["r-1", "r-2"]);
    await store.refresh();
    expect(store.getSnapshot().drafts).toHaveLength(2);
  });

  it("discards through drafts.delete when deleting in Drafts", async () => {
    const live = liveBackend(async () => [draftRow(11, "r-1")]);
    const store = new WinnowStore({ backend: live.backend });
    await store.connect(live.backend, { email: "me@example.com" });
    store.setMailbox("drafts");
    await store.refreshDrafts();
    store.trash(11);
    expect(store.getSnapshot().drafts).toHaveLength(0);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(live.deleted).toEqual(["r-1"]);
  });

  it("puts a draft back when the discard fails", async () => {
    const live = liveBackend(async () => [draftRow(11, "r-1")]);
    const store = new WinnowStore({ backend: live.backend });
    await store.connect(live.backend, { email: "me@example.com" });
    store.setMailbox("drafts");
    await store.refreshDrafts();
    live.failDeletes();
    await store.discardDrafts([11]);
    expect(store.getSnapshot().drafts.map((row) => row.gmailDraft?.id)).toEqual(["r-1"]);
    expect(store.getSnapshot().notice).toMatch(/Couldn't discard/);
  });

  it("drops a listing that lands after sign-out", async () => {
    let release: (rows: Email[]) => void = () => {};
    const live = liveBackend(() => new Promise<Email[]>((resolve) => (release = resolve)));
    const store = new WinnowStore({ backend: live.backend });
    await store.connect(live.backend, { email: "me@example.com" });
    store.setMailbox("drafts");
    const listing = store.refreshDrafts();
    await store.signOut();
    release([draftRow(11, "r-1")]);
    await listing;
    expect(store.getSnapshot().drafts).toEqual([]);
  });

  it("updates a row in place, and removes one that was sent", () => {
    const store = new WinnowStore({ seedDrafts: [draftRow(11, "r-1"), draftRow(12, "r-2")] });
    store.putDraftRow({ ...draftRow(11, "r-1", 5_000), subject: "Edited" });
    expect(store.getSnapshot().drafts[0]).toMatchObject({ subject: "Edited" });
    expect(store.getSnapshot().drafts).toHaveLength(2);
    store.removeDraftRow("r-2");
    expect(store.getSnapshot().drafts.map((row) => row.gmailDraft?.id)).toEqual(["r-1"]);
  });
});

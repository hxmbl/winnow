import { describe, expect, it } from "vitest";
import { WinnowStore, type MailBackend, type PlatformBridge } from "../store/store";
import { revivePreferences } from "../store/preferences";
import type { Draft, Email } from "../model/email";
import type { KeptReply } from "./notifications";

function mail(id: number, overrides: Partial<Email> = {}): Email {
  return {
    id,
    gmailId: `g${id}`,
    threadId: `t${id}`,
    sender: `sender${id}@example.com`,
    name: `Sender ${id}`,
    mailbox: "inbox",
    receivedAt: 1_000 + id,
    subject: `Subject ${id}`,
    body: "Hello",
    category: "primary",
    starred: false,
    unread: true,
    urgent: false,
    attachments: [],
    ...overrides,
  } as Email;
}

/** A backend whose second sync brings `arrivals`, and that records draft saves. */
function harness(arrivals: Email[], options: { draftFails?: (draft: Draft) => boolean } = {}) {
  const first = [mail(1, { unread: false })];
  let syncs = 0;
  const drafts: { draft: Draft; replyTo?: string }[] = [];
  const notified: Email[][] = [];
  const backend: MailBackend = {
    async sync() {
      syncs += 1;
      return { emails: syncs === 1 ? first : [...first, ...arrivals], failed: 0, truncated: false };
    },
    async toggleStar() {},
    async moveToMailbox() {},
    async setRead() {},
    async deletePermanently() {},
    async sendReply() {},
    async fetchBody() {
      return "";
    },
    async fetchAttachment() {
      return { bytes: new Uint8Array(), filename: "a", mimeType: "application/octet-stream" };
    },
    drafts: {
      async create(draft, replyTo) {
        if (options.draftFails?.(draft)) throw new Error("offline");
        drafts.push({ draft, replyTo });
        return `d${drafts.length}`;
      },
      async update(id) {
        return id;
      },
      async delete() {},
    },
    async replyHeads(gmailIds) {
      return Object.fromEntries(gmailIds.map((id) => [id, `HEAD-${id}`]));
    },
  };
  const platform: PlatformBridge = {
    async notifyNewMail(emails) {
      notified.push([...emails]);
    },
    async setUnreadBadge() {},
    async setBackgroundSync() {},
  };
  const store = new WinnowStore({ platform });
  return { store, backend, drafts, notified };
}

describe("what a sync announces", () => {
  it("announces only unread inbox mail from senders neither muted nor hidden", async () => {
    const { store, backend, notified } = harness([
      mail(2),
      mail(3, { unread: false }),
      mail(4, { sender: "muted@example.com" }),
      mail(5, { sender: "hidden@example.com" }),
      mail(6, { mailbox: "archive" }),
    ]);
    store.setPreferences({
      notificationsEnabled: true,
      mutedSenders: ["muted@example.com"],
      blockedSenders: ["hidden@example.com"],
    });
    await store.connect(backend, { email: "me@example.com" });
    expect(notified).toEqual([]);
    await store.refresh();
    const ids = notified.flat().map((email) => email.id);
    expect(ids).toEqual([2]);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(4);
    expect(ids).not.toContain(5);
    expect(ids).not.toContain(6);
  });

  it("asks the backend for reply heads only while Reply is on", async () => {
    const { store, backend } = harness([]);
    await store.connect(backend, { email: "me@example.com" });
    const heads = await store.notificationReplyHeads([mail(7)]);
    expect(heads).toEqual({ g7: "HEAD-g7" });
    store.setPreferences({ notificationActions: { reply: false, trash: true, read: true } });
    expect(await store.notificationReplyHeads([mail(7)])).toEqual({});
  });
});

describe("replies the phone kept", () => {
  const kept = (gmailId: string, reply: string): KeptReply => ({
    requestId: `r-${gmailId}`,
    gmailId,
    threadId: "t1",
    messageId: 1,
    title: "Ada",
    subject: "Plan",
    replyHead: "To: ada@example.com\r\nIn-Reply-To: <p@q.r>\r\n\r\n",
    reply,
    at: 0,
  });

  it("saves each to Drafts, threaded, and hands back the ones that failed", async () => {
    const { store, backend, drafts } = harness([], { draftFails: (draft) => draft.body === "fails" });
    await store.connect(backend, { email: "me@example.com" });
    const result = await store.saveKeptReplies([kept("g1", "On my way"), kept("gone", "fails"), kept("gone2", "Saved too")]);
    expect(result.saved).toBe(2);
    expect(result.failed.map((reply) => reply.gmailId)).toEqual(["gone"]);
    expect(drafts[0].draft.body).toBe("On my way");
    expect(drafts[1].draft.replyHeaders?.inReplyTo).toBe("<p@q.r>");
  });
});

describe("notification preferences survive a restart", () => {
  it("keeps each button on its own and the privacy switch", () => {
    expect(revivePreferences({ notificationActions: { reply: false, trash: "yes" }, notificationHidePreview: true })).toEqual({
      notificationActions: { reply: false, trash: true, read: true },
      notificationHidePreview: true,
    });
    expect(revivePreferences({ notificationHidePreview: "on" })).toEqual({});
  });
});

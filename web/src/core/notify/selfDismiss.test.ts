import { describe, expect, it } from "vitest";
import { WinnowStore, type MailBackend, type PlatformBridge } from "../store/store";
import type { Email } from "../model/email";
import { buildNotificationBatch, staleNotices, stillNeedsAttention, summaryAfterWithdraw, MAX_MESSAGE_NOTIFICATIONS } from "./notifications";

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

describe("which notifications are stale", () => {
  it("read, archived, trashed, spam or snoozed mail needs no attention; unread inbox mail does", () => {
    expect(stillNeedsAttention({ unread: true, mailbox: "inbox" })).toBe(true);
    expect(stillNeedsAttention({ unread: false, mailbox: "inbox" })).toBe(false);
    for (const mailbox of ["archive", "trash", "spam", "snoozed"] as const) {
      expect(stillNeedsAttention({ unread: true, mailbox: mailbox as Email["mailbox"] })).toBe(false);
    }
  });

  it("only watched messages the mailbox holds are judged; one it doesn't hold is left alone", () => {
    const emails = [mail(1, { unread: false }), mail(2), mail(3, { mailbox: "archive" as Email["mailbox"] }), mail(4, { unread: false })];
    expect(staleNotices(["g1", "g2", "g3", "g9"], emails)).toEqual(["g1", "g3"]);
    expect(staleNotices([], emails)).toEqual([]);
  });

  it("a summary shrinks with what it counts and goes once none of its extras is left", () => {
    expect(summaryAfterWithdraw(6, 1)).toEqual({ title: "6 new messages", body: "1 more in Winnow" });
    expect(summaryAfterWithdraw(1, 1)).toEqual({ title: "1 new message", body: "1 more in Winnow" });
    expect(summaryAfterWithdraw(5, 0)).toBeNull();
    expect(summaryAfterWithdraw(0, 0)).toBeNull();
  });

  it("a batch names the messages its summary counts without their own notification", () => {
    const emails = Array.from({ length: MAX_MESSAGE_NOTIFICATIONS + 2 }, (_, i) => mail(i + 1));
    const batch = buildNotificationBatch(emails, {
      notificationActions: { reply: true, trash: true, read: true },
      notificationHidePreview: false,
    });
    expect(batch.messages).toHaveLength(MAX_MESSAGE_NOTIFICATIONS);
    expect(batch.restIds).toEqual(["g6", "g7"]);
  });
});

/** A store whose second sync brings new mail, and a platform that records what it is asked. */
function harness(second: Email[], third?: Email[]) {
  const first = [mail(1, { unread: false })];
  let syncs = 0;
  const withdrawn: string[][] = [];
  const cleared: (string | null)[] = [];
  let active: { account: string | null; gmailId: string }[] = [];
  const backend: MailBackend = {
    async sync() {
      syncs += 1;
      const emails = syncs === 1 ? first : syncs === 2 ? [...first, ...second] : [...first, ...(third ?? second)];
      return { emails, failed: 0, truncated: false };
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
  };
  const platform: PlatformBridge = {
    async notifyNewMail() {},
    async withdrawNotifications(gmailIds) {
      withdrawn.push([...gmailIds]);
    },
    async activeNotifications() {
      return active;
    },
    async clearNotifications(account) {
      cleared.push(account);
    },
    async setUnreadBadge() {},
    async setBackgroundSync() {},
  };
  const store = new WinnowStore({ platform });
  store.setPreferences({ notificationsEnabled: true });
  return {
    store,
    backend,
    withdrawn,
    cleared,
    setActive: (list: typeof active) => {
      active = list;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("notifications that dismiss themselves", () => {
  it("marking a notified message read here takes its notification down", async () => {
    const { store, backend, withdrawn } = harness([mail(2), mail(3)]);
    await store.connect(backend, { email: "me@example.com" });
    await store.refresh();
    expect(withdrawn).toEqual([]);
    store.setRead(2, true);
    expect(withdrawn.flat()).toEqual(["g2"]);
    // Once is enough: the second change does not ask again.
    store.setRead(2, true);
    expect(withdrawn.flat()).toEqual(["g2"]);
  });

  it("archiving or trashing it here takes it down too", async () => {
    const { store, backend, withdrawn } = harness([mail(2), mail(3)]);
    await store.connect(backend, { email: "me@example.com" });
    await store.refresh();
    store.archive(2);
    expect(withdrawn.flat()).toEqual(["g2"]);
    store.moveWithUndo(3, "trash");
    expect(withdrawn.flat()).toEqual(["g2", "g3"]);
  });

  it("mail read on another device goes when the next sync brings that in", async () => {
    const { store, backend, withdrawn } = harness([mail(2), mail(3)], [mail(2, { unread: false }), mail(3)]);
    await store.connect(backend, { email: "me@example.com" });
    await store.refresh();
    await store.refresh();
    expect(withdrawn.flat()).toEqual(["g2"]);
  });

  it("notifications Android's background service posted are adopted and dismissed when already dealt with", async () => {
    const { store, backend, withdrawn, setActive } = harness([mail(2, { unread: false }), mail(3)]);
    await store.connect(backend, { email: "me@example.com" });
    setActive([
      { account: null, gmailId: "g2" },
      { account: null, gmailId: "g3" },
      { account: "otheracct", gmailId: "g2" },
    ]);
    await store.refresh();
    await flush();
    expect(withdrawn.flat()).toEqual(["g2"]);
  });

  it("signing out clears every notification of the account", async () => {
    const { store, backend, cleared } = harness([mail(2)]);
    await store.connect(backend, { email: "me@example.com" });
    await store.signOut();
    expect(cleared).toEqual([null]);
  });
});

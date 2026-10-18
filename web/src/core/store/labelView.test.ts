/**
 * Browsing a label as a mailbox, and labels landing on a whole conversation.
 */

import { describe, expect, it, vi } from "vitest";
import { WinnowStore, type MailBackend } from "./store";
import { DEMO_EMAILS, DEMO_LABELS } from "../data/demo";
import type { Email } from "../model/email";
import { inLabelView, labelTargets } from "./labelView";

function mail(id: number, fields: Partial<Email>): Email {
  return {
    id,
    gmailId: `g${id}`,
    sender: `s${id}@example.com`,
    subject: `Subject ${id}`,
    body: "",
    receivedAt: 1_700_000_000_000 + id * 60_000,
    mailbox: "inbox",
    category: "primary",
    starred: false,
    unread: false,
    attachments: [],
    urgent: false,
    ...fields,
  } as Email;
}

describe("which messages a label lists", () => {
  it("is every message with it, wherever filed, except Trash, Spam and Drafts", () => {
    expect(inLabelView({ labels: ["Label_1"], mailbox: "inbox" }, "Label_1")).toBe(true);
    expect(inLabelView({ labels: ["Label_1"], mailbox: "archive" }, "Label_1")).toBe(true);
    expect(inLabelView({ labels: ["Label_1"], mailbox: "sent" }, "Label_1")).toBe(true);
    expect(inLabelView({ labels: ["Label_1"], mailbox: "trash" }, "Label_1")).toBe(false);
    expect(inLabelView({ labels: ["Label_1"], mailbox: "spam" }, "Label_1")).toBe(false);
    expect(inLabelView({ labels: ["Label_2"], mailbox: "inbox" }, "Label_1")).toBe(false);
    expect(inLabelView({ mailbox: "inbox" }, "Label_1")).toBe(false);
  });

  it("widens a change to every message on the targets' conversations", () => {
    const all = [mail(1, { threadId: "t" }), mail(2, { threadId: "t" }), mail(3, { threadId: "u" }), mail(4, {})];
    expect([...labelTargets(all, [1, 4])].sort()).toEqual([1, 2, 4]);
  });
});

describe("the store's label view", () => {
  const seed = [
    mail(1, { labels: ["Label_1"] }),
    mail(2, { labels: ["Label_1"], mailbox: "archive" }),
    mail(3, { labels: ["Label_1"], mailbox: "trash" }),
    mail(4, {}),
  ];
  const store = () => new WinnowStore({ seed, seedLabels: DEMO_LABELS });

  it("lists the label's mail from every mailbox and names the list after it", () => {
    const s = store();
    s.setLabelView("Label_1");
    const ids = s.getSnapshot().view.threads.map((row) => row.representative.id).sort();
    expect(ids).toEqual([1, 2]);
    expect(s.listTitle()).toBe("Travel");
    expect(s.labelViewName()).toBe("Travel");
  });

  it("leaves the label for a mailbox, including the one it was browsed from", () => {
    const s = store();
    s.setLabelView("Label_1");
    s.setMailbox("inbox");
    expect(s.getSnapshot().labelView).toBeNull();
    expect(s.getSnapshot().view.threads.map((row) => row.representative.id).sort()).toEqual([1, 4]);
    expect(s.listTitle()).toBe("Inbox");
  });

  it("drops the reader and the filters on the way in", () => {
    const s = store();
    s.select(4);
    s.setLabelView("Label_1");
    expect(s.getSnapshot().selectedId).toBeNull();
    expect(s.getSnapshot().activeFilters).toEqual([]);
  });

  it("takes a message off the list when its label is removed", () => {
    const s = store();
    s.setLabelView("Label_1");
    s.applyLabels([1], [], ["Label_1"]);
    expect(s.getSnapshot().view.threads.map((row) => row.representative.id)).toEqual([2]);
  });

  it("labels the rest of a conversation with it, and asks Gmail once by message", () => {
    const modifyLabels = vi.fn(async () => undefined);
    const s = new WinnowStore({
      seed: [mail(1, { threadId: "t" }), mail(2, { threadId: "t" }), mail(3, {})],
      backend: { modifyLabels } as unknown as MailBackend,
    });
    s.applyLabels([1], ["Label_4"], []);
    const labels = (id: number) => s.getSnapshot().all.find((email) => email.id === id)?.labels;
    expect(labels(1)).toEqual(["Label_4"]);
    expect(labels(2)).toEqual(["Label_4"]);
    expect(labels(3)).toBeUndefined();
    expect(modifyLabels).toHaveBeenCalledWith([1], ["Label_4"], []);
  });

  it("works on the demo mailbox", () => {
    const s = new WinnowStore({ seed: [...DEMO_EMAILS], seedLabels: DEMO_LABELS });
    s.setLabelView("Label_2");
    expect(s.getSnapshot().view.threads.length).toBeGreaterThan(0);
    expect(s.getSnapshot().view.threads.every((row) => row.representative.labels?.includes("Label_2"))).toBe(true);
  });
});

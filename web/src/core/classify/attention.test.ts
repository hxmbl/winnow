import { describe, expect, it } from "vitest";
import { attentionSentence, NO_ATTENTION, summarizeAttention } from "./attention";
import { classifyAll } from "./classify";
import { buildUserProfile } from "../model/profile";
import { NEUTRAL_SIGNALS, type EmailSignals } from "../model/signals";
import { DEMO_EMAILS, DEMO_NOW, DEMO_TRASH } from "../data/demo";
import type { Email } from "../model/email";

const HOUR = 60 * 60 * 1000;

function email(over: Partial<Email> = {}): Email {
  return {
    id: 1,
    gmailId: "g1",
    sender: "someone@northwind.example",
    mailbox: "inbox",
    receivedAt: DEMO_NOW - HOUR,
    subject: "",
    body: "",
    category: "primary",
    starred: false,
    unread: true,
    attachments: [],
    urgent: false,
    ...over,
  };
}

function signals(entries: [number, Partial<EmailSignals>][]): Map<number, EmailSignals> {
  return new Map(entries.map(([id, over]) => [id, { ...NEUTRAL_SIGNALS, ...over }]));
}

describe("attentionSentence", () => {
  it("says so when nothing needs you", () => {
    expect(attentionSentence(NO_ATTENTION)).toBe("Nothing needs you right now");
  });

  it("reads like a sentence, with singulars and an 'and'", () => {
    expect(attentionSentence({ waiting: 1, security: 0, deliveries: 0 })).toBe("1 waiting on you");
    expect(attentionSentence({ waiting: 3, security: 0, deliveries: 2 })).toBe(
      "3 waiting on you and 2 emails about deliveries today",
    );
    expect(attentionSentence({ waiting: 3, security: 1, deliveries: 1 })).toBe(
      "3 waiting on you, 1 security email and 1 email about deliveries today",
    );
    expect(attentionSentence({ waiting: 0, security: 2, deliveries: 0 })).toBe("2 security emails");
  });
});

describe("summarizeAttention", () => {
  it("counts only unread mail as waiting or as an alert", () => {
    const mail = [
      email({ id: 1, unread: true }),
      email({ id: 2, unread: false }),
      email({ id: 3, unread: true }),
    ];
    const s = signals([
      [1, { needsAction: true }],
      [2, { needsAction: true, security: true }],
      [3, { security: true }],
    ]);
    expect(summarizeAttention(mail, s, DEMO_NOW)).toEqual({ waiting: 1, security: 1, deliveries: 0 });
  });

  it("counts a delivery only on the day it arrived, read or not", () => {
    const mail = [
      email({ id: 1, unread: false }),
      email({ id: 2, receivedAt: DEMO_NOW - 30 * HOUR }),
    ];
    const s = signals([
      [1, { shipping: true }],
      [2, { shipping: true }],
    ]);
    expect(summarizeAttention(mail, s, DEMO_NOW).deliveries).toBe(1);
  });

  it("never counts unsafe mail, newsletters asking for action, or other mailboxes", () => {
    const mail = [
      email({ id: 1 }),
      email({ id: 2 }),
      email({ id: 3, mailbox: "archive" }),
    ];
    const s = signals([
      [1, { needsAction: true, security: true, spamLikelihood: 0.9 }],
      [2, { needsAction: true, newsletter: true }],
      [3, { needsAction: true }],
    ]);
    expect(summarizeAttention(mail, s, DEMO_NOW)).toEqual(NO_ATTENTION);
  });

  it("finds something to say about the demo inbox", () => {
    const inbox = DEMO_EMAILS.filter((m) => m.mailbox === "inbox");
    const profile = buildUserProfile(inbox, DEMO_TRASH);
    const summary = summarizeAttention(inbox, classifyAll(inbox, profile), DEMO_NOW);
    expect(summary.waiting + summary.security + summary.deliveries).toBeGreaterThan(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_ACTIONS,
  MAX_MESSAGE_NOTIFICATIONS,
  buildNotificationBatch,
  censorNotificationBatch,
  draftForKeptReply,
  handleNotificationAction,
  messageLink,
  parseDeepLink,
  notifiable,
  notificationReplyDraft,
  parseKeptReply,
  parseNotificationAction,
  previewOf,
  recipientOfHead,
  type NotificationActionDeps,
  type NotificationActionEvent,
} from "./notifications";
import type { Email } from "../model/email";
import { AddressScrambler } from "../mail/censor";
import { buildMime, messageIdFor } from "../gmail/mime";

function mail(overrides: Partial<Email> = {}): Email {
  return {
    id: 1,
    gmailId: "18a",
    threadId: "t18a",
    messageId: "<orig@mail.example.com>",
    sender: "ada@example.com",
    name: "Ada Lovelace",
    mailbox: "inbox",
    receivedAt: 1_000,
    subject: "The plan",
    body: "Hi there,\nCan we meet Thursday?",
    category: "primary",
    starred: false,
    unread: true,
    urgent: false,
    attachments: [],
    ...overrides,
  } as Email;
}

const SETTINGS = { notificationActions: DEFAULT_NOTIFICATION_ACTIONS, notificationHidePreview: false };

describe("which mail notifies", () => {
  it("only unread inbox mail from senders neither muted nor hidden, newest first", () => {
    const emails = [
      mail({ id: 1, receivedAt: 1 }),
      mail({ id: 2, receivedAt: 3 }),
      mail({ id: 3, unread: false }),
      mail({ id: 4, mailbox: "archive" }),
      mail({ id: 5, sender: "Muted@Example.com" }),
      mail({ id: 6, sender: "hidden@example.com" }),
      mail({ id: 7, mailbox: "spam" }),
    ];
    const out = notifiable(emails, { mutedSenders: ["muted@example.com"], blockedSenders: ["HIDDEN@example.com"] });
    expect(out.map((email) => email.id)).toEqual([2, 1]);
  });
});

describe("the batch", () => {
  it("names the sender and subject for one message", () => {
    const batch = buildNotificationBatch([mail()], SETTINGS, { "18a": "HEAD" });
    expect(batch.total).toBe(1);
    expect(batch.summaryTitle).toBe("Ada Lovelace");
    expect(batch.summaryBody).toBe("The plan");
    expect(batch.messages).toEqual([
      {
        messageId: 1,
        gmailId: "18a",
        threadId: "t18a",
        title: "Ada Lovelace",
        subject: "The plan",
        preview: "Hi there,",
        receivedAt: 1_000,
        replyHead: "HEAD",
        picture: null,
      },
    ]);
  });

  it("caps per-message notifications and counts the rest in the summary", () => {
    const emails = Array.from({ length: 8 }, (_, i) =>
      mail({ id: i, gmailId: `g${i}`, name: `Sender ${i % 5}`, sender: `s${i % 5}@example.com` }),
    );
    const batch = buildNotificationBatch(emails, SETTINGS);
    expect(batch.messages).toHaveLength(MAX_MESSAGE_NOTIFICATIONS);
    expect(batch.total).toBe(8);
    expect(batch.summaryTitle).toBe("8 new messages");
    expect(batch.summaryBody).toBe("Sender 0, Sender 1, Sender 2 and 2 more");
  });

  it("carries the button and privacy settings, and drops the reply head when Reply is off", () => {
    const batch = buildNotificationBatch(
      [mail()],
      { notificationActions: { reply: false, trash: true, read: false }, notificationHidePreview: true },
      { "18a": "HEAD" },
    );
    expect(batch.actions).toEqual({ reply: false, trash: true, read: false });
    expect(batch.hidePreview).toBe(true);
    expect(batch.messages[0].replyHead).toBeNull();
  });

  it("carries each message's sender picture, and none at all while previews are hidden", () => {
    const pictures = { "18a": "https://gravatar.com/avatar/x?d=404&s=192" };
    expect(buildNotificationBatch([mail()], SETTINGS, {}, pictures).messages[0].picture).toBe(pictures["18a"]);
    expect(buildNotificationBatch([mail({ gmailId: "18b" })], SETTINGS, {}, pictures).messages[0].picture).toBeNull();
    const hidden = { ...SETTINGS, notificationHidePreview: true };
    expect(buildNotificationBatch([mail()], hidden, {}, pictures).messages[0].picture).toBeNull();
  });

  it("previews the first line that is not a quote", () => {
    expect(previewOf(mail({ body: "\n> earlier\n\n  Yes, Thursday works.  \nmore" }))).toBe("Yes, Thursday works.");
    expect(previewOf(mail({ body: "" }))).toBe("");
    expect(previewOf(mail({ body: "x".repeat(300) })).length).toBe(140);
  });
});

describe("censored notifications", () => {
  it("scrambles every address a person reads and leaves the reply head and ids alone", () => {
    let x = 7;
    const scrambler = new AddressScrambler(() => ((x = (x * 48271) % 2147483647) / 2147483647));
    const nameless = mail({ name: "ada@example.com", body: "Sent from ada@example.com\nmore" });
    const batch = buildNotificationBatch([nameless], SETTINGS, { "18a": "To: ada@example.com" }, {}, {
      id: "acct-1",
      label: "me@example.org",
    });
    const out = censorNotificationBatch(batch, scrambler);
    const shown = JSON.stringify({ ...out, messages: out.messages.map((m) => ({ ...m, replyHead: null })) });
    expect(shown).not.toContain("ada@example.com");
    expect(shown).not.toContain("me@example.org");
    expect(out.messages[0].title).toBe(scrambler.scramble("ada@example.com"));
    expect(out.summaryTitle).toBe(scrambler.scramble("ada@example.com"));
    expect(out.messages[0].replyHead).toBe("To: ada@example.com");
    expect(out.messages[0].gmailId).toBe("18a");
    expect(out.messages[0].messageId).toBe(1);
    // The input batch is not modified.
    expect(batch.messages[0].title).toBe("ada@example.com");
  });
});

describe("the reply a notification sends", () => {
  const original = mail();
  const draft = notificationReplyDraft(original);

  it("goes to the sender alone, Re: the subject, on the thread", () => {
    expect(draft.to).toEqual(["ada@example.com"]);
    expect(draft.cc).toEqual([]);
    expect(draft.subject).toBe("Re: The plan");
    expect(draft.threadId).toBe("t18a");
    expect(draft.inReplyTo).toBe("18a");
    expect(notificationReplyDraft(mail({ subject: "RE: x" })).subject).toBe("RE: x");
  });

  it("has a header block the native side accepts: threading headers, base64 body, nothing after", () => {
    const head = buildMime(draft, { from: { address: "me@example.com" }, inReplyTo: original, references: [original] });
    expect(head.endsWith("\r\n\r\n")).toBe(true);
    const block = head.slice(0, -4);
    expect(block.includes("\r\n\r\n")).toBe(false);
    const lines = block.split("\r\n");
    expect(lines).toContain(`In-Reply-To: ${messageIdFor(original)}`);
    expect(lines.find((line) => line.startsWith("References: "))?.endsWith(messageIdFor(original))).toBe(true);
    expect(lines).toContain("Content-Transfer-Encoding: base64");
    expect(lines.filter((line) => line.startsWith("Date: "))).toHaveLength(1);
  });

  it("is the composer's message: head + the body's base64 is what buildMime makes with the body", () => {
    // Pin the random boundary and the clock so the two builds are comparable.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T13:53:00Z"));
    try {
      const options = { from: { address: "me@example.com" }, inReplyTo: original, references: [original] };
      const text = "Thursday works — see you at 10.\nAda, thank you!";
      const full = buildMime(notificationReplyDraft(original, text), options);
      const head = buildMime(notificationReplyDraft(original), options);
      // What `plan.rs` appends: base64 of the UTF-8, CRLF after every full 76 characters.
      const bytes = new TextEncoder().encode(text);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const appended = btoa(binary).replace(/(.{76})/g, "$1\r\n");
      expect(head + appended).toBe(full);
      expect(head).toContain("Date: Sun, 18 Oct 2026 13:53:00 GMT");
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

describe("a press", () => {
  function deps(cached: Partial<Email> | null = { id: 9, unread: true, mailbox: "inbox" }, options: { accounts?: string[]; open?: string } = {}) {
    const calls: string[] = [];
    let open = options.open ?? "acct1";
    const d: NotificationActionDeps = {
      focusWindow: () => void calls.push("focusWindow"),
      ...(options.accounts
        ? {
            openAccount: async (id: string) => {
              if (!options.accounts!.includes(id)) return false;
              if (open !== id) calls.push(`switch:${id}`);
              open = id;
              return true;
            },
            isOpen: (id: string) => open === id,
            refreshAccount: (id: string) => void calls.push(`light:${id}`),
          }
        : {}),
      openMessage: async (gmailId, id) => {
        calls.push(`open:${gmailId}:${id}`);
        return cached !== null;
      },
      openInbox: () => void calls.push("inbox"),
      openReply: () => void calls.push("openReply"),
      find: async () => (cached ? (cached as Email) : undefined),
      setRead: (id, read) => void calls.push(`setRead:${id}:${read}`),
      trashWithUndo: (id) => void calls.push(`trash:${id}`),
      refresh: () => void calls.push("refresh"),
      confirm: (id, title, _text, failed) => void calls.push(`confirm:${id}:${title}:${failed}`),
    };
    return { d, calls };
  }
  const press = (action: NotificationActionEvent["action"], origin: NotificationActionEvent["origin"] = "desktop", account?: string) =>
    ({ action, messageId: 9, gmailId: "g9", origin, ...(account ? { account } : {}) }) as NotificationActionEvent;

  it("opens that exact message on a tap (fetched by the store when not cached)", async () => {
    const { d, calls } = deps();
    expect(await handleNotificationAction(press("open"), d)).toBe("opened");
    expect(calls).toEqual(["focusWindow", "open:g9:9"]);
  });

  it("opens the composer on the message for Reply on the desktop", async () => {
    const { d, calls } = deps();
    expect(await handleNotificationAction(press("reply"), d)).toBe("reply opened");
    expect(calls).toEqual(["focusWindow", "open:g9:9", "openReply"]);
  });

  it("does not open a composer on the wrong message when the original is gone", async () => {
    const { d, calls } = deps(null);
    expect(await handleNotificationAction(press("reply"), d)).toBe("focused");
    expect(calls).not.toContain("openReply");
  });

  it("marks read through the store and confirms", async () => {
    const { d, calls } = deps();
    await handleNotificationAction(press("read"), d);
    expect(calls).toEqual(["setRead:9:true", "confirm:9:Marked as read:false"]);
  });

  it("moves to Trash with Undo, never a permanent delete", async () => {
    const { d, calls } = deps();
    await handleNotificationAction(press("trash"), d);
    expect(calls).toEqual(["trash:9", "confirm:9:Moved to Trash:false"]);
    // Already in the Trash: the app's own Delete would destroy it there, so nothing.
    const binned = deps({ id: 9, unread: true, mailbox: "trash" });
    await handleNotificationAction(press("trash"), binned.d);
    expect(binned.calls.some((call) => call.startsWith("trash:"))).toBe(false);
    expect(binned.calls.at(-1)).toContain(":true");
  });

  it("says so when the message cannot be found", async () => {
    const { d, calls } = deps(null);
    expect(await handleNotificationAction(press("read"), d)).toBe("not cached");
    expect(calls).toEqual(["confirm:9:Couldn't do that. Open Winnow:true"]);
  });

  it("only refreshes for an Android press, which the phone already carried out", async () => {
    const { d, calls } = deps();
    await handleNotificationAction({ ...press("trash", "android"), outcome: "done" }, d);
    expect(calls).toEqual(["refresh"]);
  });

  it("switches to the notification's account before opening its message", async () => {
    const { d, calls } = deps(undefined, { accounts: ["acct1", "acct2"], open: "acct1" });
    expect(await handleNotificationAction(press("open", "web", "acct2"), d)).toBe("opened");
    expect(calls).toEqual(["focusWindow", "switch:acct2", "open:g9:9"]);
  });

  it("acts on the right account for Mark read and Delete, and leaves its inbox open", async () => {
    const { d, calls } = deps(undefined, { accounts: ["acct1", "acct2"], open: "acct1" });
    await handleNotificationAction(press("read", "desktop", "acct2"), d);
    expect(calls).toEqual(["switch:acct2", "setRead:9:true", "confirm:9:Marked as read:false"]);
  });

  it("refuses a press for an account that was signed out", async () => {
    const { d, calls } = deps(undefined, { accounts: ["acct1"], open: "acct1" });
    expect(await handleNotificationAction(press("open", "desktop", "gone1"), d)).toBe("unknown account");
    expect(calls.some((call) => call.startsWith("open:"))).toBe(false);
  });

  it("opens the account's inbox for a summary of several messages", async () => {
    const { d, calls } = deps(undefined, { accounts: ["acct1", "acct2"], open: "acct1" });
    expect(await handleNotificationAction({ ...press("inbox", "web", "acct2"), messageId: 0, gmailId: "" }, d)).toBe("inbox opened");
    expect(calls).toEqual(["focusWindow", "switch:acct2", "inbox"]);
  });

  it("an Android action on an account that is not open catches that account up, not the open one", async () => {
    const { d, calls } = deps(undefined, { accounts: ["acct1", "acct2"], open: "acct1" });
    await handleNotificationAction({ ...press("read", "android", "acct2"), outcome: "done" }, d);
    expect(calls).toEqual(["light:acct2"]);
  });

  it("validates what arrives over IPC", () => {
    expect(parseNotificationAction({ action: "read", messageId: 3, gmailId: "a", origin: "android", outcome: "failed" })).toEqual({
      action: "read",
      messageId: 3,
      gmailId: "a",
      origin: "android",
      outcome: "failed",
    });
    expect(parseNotificationAction({ action: "open", messageId: 3, gmailId: "a", origin: "desktop", account: "acct2" })?.account).toBe("acct2");
    // An account id that is not one is dropped, never passed on.
    expect(parseNotificationAction({ action: "open", messageId: 3, gmailId: "a", origin: "desktop", account: "../x" })?.account).toBeUndefined();
    expect(parseNotificationAction({ action: "delete", messageId: 3, origin: "desktop" })).toBeNull();
    expect(parseNotificationAction({ action: "read", messageId: 1.5, origin: "desktop" })).toBeNull();
    expect(parseNotificationAction({ action: "read", messageId: 1, origin: "elsewhere" })).toBeNull();
    expect(parseNotificationAction("read")).toBeNull();
  });
});

describe("deep links", () => {
  it("round-trips a notification's message link, account and Gmail id included", () => {
    const link = messageLink(42, "abc123", "acct2");
    expect(link).toBe("winnow://message/42?account=acct2&gmail=abc123");
    expect(parseDeepLink(link)).toEqual({ kind: "message", messageId: 42, gmailId: "abc123", account: "acct2" });
  });

  it("still reads 1.3.5's links", () => {
    expect(parseDeepLink("winnow://message/42")).toEqual({ kind: "message", messageId: 42, gmailId: "" });
    expect(parseDeepLink("winnow://open")).toEqual({ kind: "open" });
    expect(parseDeepLink("winnow://signed-in")).toEqual({ kind: "signed-in" });
  });

  it("a summary's link opens the account's inbox", () => {
    expect(parseDeepLink("winnow://open?account=acct2&view=inbox")).toEqual({ kind: "inbox", account: "acct2" });
  });

  it("drops what it cannot trust", () => {
    expect(parseDeepLink("winnow://message/42?account=../../x&gmail=a/b")).toEqual({ kind: "message", messageId: 42, gmailId: "" });
    expect(parseDeepLink("https://example.com/message/1")).toBeNull();
    expect(parseDeepLink("winnow://message/notanumber")).toBeNull();
  });

  it("a batch names its account, and the address only when there is more than one", () => {
    const email = { id: 1, gmailId: "g1", sender: "a@b.co", name: "Ada", subject: "Hi", body: "x", receivedAt: 1, unread: true, mailbox: "inbox" } as Email;
    const settings = { notificationActions: { reply: true, trash: true, read: true }, notificationHidePreview: false };
    expect(buildNotificationBatch([email], settings, {}, {}, { id: "acct2", label: "two@x.co" }).account).toEqual({ id: "acct2", label: "two@x.co" });
    expect(buildNotificationBatch([email], settings).account).toBeNull();
  });
});

describe("replies the phone kept", () => {
  const head = [
    "From: me <me@example.com>",
    "To: ada@example.com",
    "Subject: Re: The plan",
    "Date: Sat, 17 Oct 2026 09:00:00 GMT",
    "In-Reply-To: <orig@mail.example.com>",
    "References: <first@x.y> <orig@mail.example.com>",
    "Content-Transfer-Encoding: base64",
  ].join("\r\n") + "\r\n\r\n";
  const raw = {
    requestId: "r1",
    gmailId: "18a",
    threadId: "t18a",
    messageId: 1,
    title: "Ada",
    subject: "The plan",
    replyHead: head,
    reply: "On my way",
    at: 5,
  };

  it("parses, and refuses one without words or a usable id", () => {
    expect(parseKeptReply(raw)?.reply).toBe("On my way");
    expect(parseKeptReply({ ...raw, reply: "   " })).toBeNull();
    expect(parseKeptReply({ ...raw, gmailId: "../x" })).toBeNull();
    expect(parseKeptReply({ ...raw, requestId: undefined })).toBeNull();
  });

  it("becomes the notification's reply when the original is cached", () => {
    const draft = draftForKeptReply(parseKeptReply(raw)!, mail());
    expect(draft).toMatchObject({ to: ["ada@example.com"], subject: "Re: The plan", body: "On my way", inReplyTo: "18a" });
  });

  it("keeps its thread from the head when the original is not cached", () => {
    expect(recipientOfHead(head)).toBe("ada@example.com");
    const draft = draftForKeptReply(parseKeptReply(raw)!, undefined);
    expect(draft).toMatchObject({
      to: ["ada@example.com"],
      body: "On my way",
      threadId: "t18a",
      replyHeaders: { inReplyTo: "<orig@mail.example.com>", references: "<first@x.y> <orig@mail.example.com>" },
    });
    // The builder threads it from those headers (`buildMime`'s replyHeaders path).
    const rebuilt = buildMime(draft!, { from: { address: "me@example.com" } });
    expect(rebuilt).toContain("In-Reply-To: <orig@mail.example.com>");
    expect(draftForKeptReply(parseKeptReply({ ...raw, replyHead: null })!, undefined)).toBeNull();
  });
});

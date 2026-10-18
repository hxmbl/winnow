/**
 * The Drafts mailbox, below the store: a Gmail draft as a row (`toDraftEmail`), what a
 * row is called (`draftRowName`), reopening one in the composer (`reopenDraft`) and the
 * threading headers a reopened reply keeps when its original is not cached.
 *
 * Pinned: a reply draft reopens as a reply to the cached message it answers (by
 * `In-Reply-To`, then by thread), a forward as a forward, and one whose original is not
 * here as a message of its own that still carries `In-Reply-To` / `References` and its
 * thread id — so it never goes out as a stranger's new message.
 */

import { describe, expect, it } from "vitest";
import { draftRowFrom, draftRowName, gmailDraftContext, reopenDraft } from "./drafts";
import { toDraftEmail } from "../gmail/mapper";
import { buildMime } from "../gmail/mime";
import { LABEL, type GmailFullDraft } from "../gmail/dto";
import { DEMO_DRAFTS, DEMO_EMAILS } from "../data/demo";
import type { Draft, Email } from "../model/email";

function b64(text: string): string {
  return btoa(unescape(encodeURIComponent(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function gmailDraft(headers: Record<string, string>, body = "Hello there", threadId = "t-1"): GmailFullDraft {
  return {
    id: "r-123",
    message: {
      id: "m-draft",
      threadId,
      labelIds: [LABEL.draft],
      internalDate: "1770000000000",
      snippet: body,
      payload: {
        mimeType: "text/plain",
        headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
        body: { data: b64(body), size: body.length },
      },
    },
  };
}

function mail(over: Partial<Email>): Email {
  return {
    id: 1,
    gmailId: "g-1",
    sender: "ada@example.com",
    mailbox: "inbox",
    receivedAt: 1_000,
    subject: "The plan",
    body: "",
    category: "primary",
    starred: false,
    unread: false,
    urgent: false,
    attachments: [],
    ...over,
  };
}

/** The headers a raw message carries, decoded from what `buildMime` produced. */
function headersOf(raw: string): Record<string, string> {
  const head = raw.split("\r\n\r\n")[0]!;
  return Object.fromEntries(
    head.split("\r\n").map((line) => {
      const at = line.indexOf(": ");
      return [line.slice(0, at), line.slice(at + 2)];
    }),
  );
}

const FROM = { address: "me@example.com", name: "me" };

describe("toDraftEmail", () => {
  it("files the draft in Drafts, read and unstarred, with its id and threading headers", () => {
    const email = toDraftEmail(
      gmailDraft({
        From: "me@example.com",
        To: "Ada Lovelace <ada@example.com>",
        Subject: "Re: The plan",
        "In-Reply-To": "<orig@example.com>",
        References: "<root@example.com> <orig@example.com>",
      }),
    )!;
    expect(email.mailbox).toBe("drafts");
    expect(email.unread).toBe(false);
    expect(email.body).toBe("Hello there");
    expect(email.to).toEqual([{ address: "ada@example.com", name: "Ada Lovelace" }]);
    expect(email.gmailDraft).toEqual({
      id: "r-123",
      inReplyTo: "<orig@example.com>",
      references: "<root@example.com> <orig@example.com>",
    });
  });

  it("maps a blank draft rather than dropping it", () => {
    const email = toDraftEmail(gmailDraft({ From: "me@example.com" }, ""));
    expect(email?.gmailDraft?.id).toBe("r-123");
    expect(email?.subject).toBe("");
  });

  it("is null for a draft with no message", () => {
    expect(toDraftEmail({ id: "r-1" })).toBeNull();
  });
});

describe("draftRowName", () => {
  it("names the draft by who it is to, as Gmail does", () => {
    expect(draftRowName({ to: [{ address: "ada@example.com", name: "Ada Lovelace" }] })).toBe("Ada Lovelace");
    expect(
      draftRowName({ to: [{ address: "ada@example.com" }], cc: [{ address: "bo@example.com" }] }),
    ).toBe("ada +1");
    expect(draftRowName({ to: [] })).toBe("No recipients");
  });
});

describe("reopenDraft", () => {
  const original = mail({ gmailId: "g-orig", messageId: "<orig@example.com>", threadId: "t-1", receivedAt: 500 });
  const later = mail({ id: 2, gmailId: "g-later", threadId: "t-1", receivedAt: 900, messageId: "<later@example.com>" });

  it("reopens a reply on the message its In-Reply-To names, so it sends threaded", () => {
    const row = toDraftEmail(
      gmailDraft({ To: "ada@example.com", Subject: "Re: The plan", "In-Reply-To": "<orig@example.com>" }),
    )!;
    const reopened = reopenDraft(row, [original, later])!;
    expect(reopened.mode).toBe("reply");
    expect(reopened.replyTo).toBe("g-orig");
    expect(reopened.gmailDraftId).toBe("r-123");
    expect(reopened.context).toBe(gmailDraftContext("r-123"));
    expect(reopened.draft).toMatchObject({ to: ["ada@example.com"], subject: "Re: The plan", body: "Hello there" });
    // All of the body is the user's now: nothing to strip, nothing prefilled.
    expect(reopened.draft.quoteBlock).toBeUndefined();
    expect(reopened.draft.prefilled).toBeUndefined();
  });

  it("falls back to the newest message on its thread", () => {
    const row = toDraftEmail(gmailDraft({ To: "ada@example.com", Subject: "Re: The plan" }))!;
    expect(reopenDraft(row, [original, later])!.replyTo).toBe("g-later");
  });

  it("reads a Fwd: subject as a forward", () => {
    const row = toDraftEmail(gmailDraft({ To: "bo@example.com", Subject: "Fwd: The plan" }))!;
    expect(reopenDraft(row, [original])!.mode).toBe("forward");
  });

  it("keeps the threading headers of a reply whose original is not cached", () => {
    const row = toDraftEmail(
      gmailDraft(
        { To: "ada@example.com", Subject: "Re: Old", "In-Reply-To": "<gone@example.com>", References: "<root@example.com> <gone@example.com>" },
        "Late reply",
        "t-old",
      ),
    )!;
    const reopened = reopenDraft(row, [original])!;
    expect(reopened.mode).toBe("new");
    expect(reopened.replyTo).toBeUndefined();
    expect(reopened.draft.threadId).toBe("t-old");
    expect(reopened.draft.replyHeaders).toEqual({
      inReplyTo: "<gone@example.com>",
      references: "<root@example.com> <gone@example.com>",
    });
    const headers = headersOf(buildMime(reopened.draft, { from: FROM }));
    expect(headers["In-Reply-To"]).toBe("<gone@example.com>");
    expect(headers["References"]).toBe("<root@example.com> <gone@example.com>");
  });

  it("is a plain new message when it was never a reply", () => {
    const row = toDraftEmail(gmailDraft({ To: "ada@example.com", Subject: "Hello" }, "Hi", ""))!;
    const reopened = reopenDraft(row, [original])!;
    expect(reopened.mode).toBe("new");
    expect(reopened.draft.replyHeaders).toBeUndefined();
    expect(headersOf(buildMime(reopened.draft, { from: FROM }))["In-Reply-To"]).toBeUndefined();
  });

  it("is null for a row that is not a draft", () => {
    expect(reopenDraft(original, [original])).toBeNull();
  });
});

describe("buildMime with a reopened draft's headers", () => {
  it("writes message-ids only, never a smuggled header", () => {
    const draft: Draft = {
      to: ["ada@example.com"],
      cc: [],
      bcc: [],
      subject: "Re: x",
      body: "b",
      replyHeaders: { inReplyTo: "<a@example.com>\r\nBcc: evil@example.com", references: "junk <r@example.com>" },
    };
    const raw = buildMime(draft, { from: FROM });
    expect(raw).not.toContain("evil@example.com");
    const headers = headersOf(raw);
    expect(headers["In-Reply-To"]).toBe("<a@example.com>");
    expect(headers["References"]).toBe("<r@example.com> <a@example.com>");
  });

  it("is ignored when the reply has its original to thread on", () => {
    const draft: Draft = {
      to: ["ada@example.com"],
      cc: [],
      bcc: [],
      subject: "Re: x",
      body: "b",
      replyHeaders: { inReplyTo: "<stale@example.com>" },
    };
    const raw = buildMime(draft, { from: FROM, inReplyTo: mail({ messageId: "<live@example.com>" }) });
    expect(headersOf(raw)["In-Reply-To"]).toBe("<live@example.com>");
  });
});

describe("draftRowFrom", () => {
  it("shows the composer's latest words on the row, keeping the draft id", () => {
    const row = DEMO_DRAFTS[0]!;
    const next = draftRowFrom(row, { to: ["x@example.com"], cc: [], bcc: [], subject: "New", body: "Edited" }, 42);
    expect(next).toMatchObject({ subject: "New", body: "Edited", receivedAt: 42, to: [{ address: "x@example.com" }] });
    expect(next.gmailDraft).toEqual(row.gmailDraft);
  });
});

describe("the demo's drafts", () => {
  it("are Drafts rows, newest first, and one reopens as a reply on its thread", () => {
    expect(DEMO_DRAFTS.length).toBeGreaterThanOrEqual(2);
    for (const draft of DEMO_DRAFTS) {
      expect(draft.mailbox).toBe("drafts");
      expect(draft.gmailDraft?.id).toBeTruthy();
    }
    const times = DEMO_DRAFTS.map((draft) => draft.receivedAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const replies = DEMO_DRAFTS.map((draft) => reopenDraft(draft, DEMO_EMAILS)).filter((r) => r?.mode === "reply");
    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(DEMO_EMAILS.some((email) => email.gmailId === replies[0]!.replyTo)).toBe(true);
  });
});

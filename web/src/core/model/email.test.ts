import { describe, expect, it } from "vitest";
import { hashId, localId, threadKey } from "./ids";
import { displayAddress, displayName, formatContact, isMailbox, MAILBOXES, MAILBOX_LABEL, mimeTypeForFilename, monogram, recipientLines, VIEW_MAILBOXES } from "./email";
import type { Email } from "./email";

function email(over: Partial<Email> = {}): Email {
  return {
    id: 1,
    gmailId: "g1",
    sender: "ada@example.com",
    mailbox: "inbox",
    receivedAt: 0,
    subject: "",
    body: "",
    category: "primary",
    starred: false,
    unread: false,
    attachments: [],
    urgent: false,
    ...over,
  };
}

describe("hashId", () => {
  it("is deterministic, so a cached classification survives a restart", () => {
    expect(hashId("18d3f0c4a5b6c7d8")).toBe(hashId("18d3f0c4a5b6c7d8"));
  });

  it("stays inside the safe-integer range", () => {
    for (const id of ["a", "18d3f0c4a5b6c7d8", "x".repeat(500), "ünïcödé-id"]) {
      const hashed = hashId(id);
      expect(Number.isSafeInteger(hashed)).toBe(true);
      expect(hashed).toBeGreaterThanOrEqual(0);
    }
  });

  it("separates ids that differ by one character", () => {
    expect(hashId("msg-1")).not.toBe(hashId("msg-2"));
  });

  it("hashes non-ASCII by its UTF-8 bytes, not its code units", () => {
    expect(hashId("café")).toBe(hashId("café"));
  });
});

describe("threadKey", () => {
  it("groups by the thread Gmail supplies", () => {
    expect(threadKey({ gmailId: "a", threadId: "t1" })).toBe("t1");
    expect(threadKey({ gmailId: "b", threadId: "t1" })).toBe("t1");
  });

  it("keeps a thread-less message on its own", () => {
    expect(threadKey({ gmailId: "a" })).toBe("single-a");
    expect(threadKey({ gmailId: "b" })).not.toBe(threadKey({ gmailId: "a" }));
  });
});

describe("localId", () => {
  it("never repeats", () => {
    const ids = Array.from({ length: 100 }, localId);
    expect(new Set(ids).size).toBe(100);
  });

  it("stays clear of the hash space, which is non-negative", () => {
    expect(localId()).toBeLessThan(0);
    expect(hashId("anything")).toBeGreaterThanOrEqual(0);
  });
});

describe("displayName", () => {
  it("prefers the header name", () => {
    expect(displayName(email({ name: "Ada Lovelace", sender: "ada@example.com" }))).toBe("Ada Lovelace");
  });

  it("falls back to the local part of the address", () => {
    expect(displayName(email({ sender: "ada.lovelace@example.com" }))).toBe("ada.lovelace");
  });

  it("falls back to the whole address when there is no local part", () => {
    expect(displayName(email({ sender: "@example.com" }))).toBe("@example.com");
  });

  it("ignores a whitespace-only name", () => {
    expect(displayName(email({ name: "   ", sender: "ada@example.com" }))).toBe("ada");
  });
});

describe("displayAddress", () => {
  it("prefers the explicit address", () => {
    expect(displayAddress(email({ address: "real@example.com", sender: "noreply@relay.io" }))).toBe(
      "real@example.com",
    );
  });

  it("falls back to the sender", () => {
    expect(displayAddress(email({ sender: "noreply@relay.io" }))).toBe("noreply@relay.io");
  });
});

describe("monogram", () => {
  it("takes the first character, uppercased", () => {
    expect(monogram(email({ name: "ada lovelace" }))).toBe("A");
  });

  it("survives a name that is only whitespace", () => {
    expect(monogram(email({ name: "  ", sender: "x@y.com" }))).toBe("X");
  });
});

describe("mimeTypeForFilename", () => {
  it("maps known extensions", () => {
    expect(mimeTypeForFilename("report.pdf")).toBe("application/pdf");
    expect(mimeTypeForFilename("photo.JPEG")).toBe("image/jpeg");
  });

  it("defaults to opaque bytes for anything unknown", () => {
    expect(mimeTypeForFilename("mystery.qqq")).toBe("application/octet-stream");
    expect(mimeTypeForFilename("noextension")).toBe("application/octet-stream");
  });
});

describe("isMailbox", () => {
  it("narrows only the real mailboxes", () => {
    expect(isMailbox("spam")).toBe(true);
    expect(isMailbox("sent")).toBe(true);
    // Drafts is a mailbox now: its rows are the Gmail drafts the drafts API lists.
    expect(isMailbox("drafts")).toBe(true);
    expect(isMailbox("outbox")).toBe(false);
    expect(isMailbox(7)).toBe(false);
  });

  it("gives every mailbox exactly one label", () => {
    // "One name per folder" — the palette reads `MAILBOX_LABEL` too, so a mailbox
    // without one renders as `undefined` rather than as a row with no text.
    expect(Object.keys(MAILBOX_LABEL).sort()).toEqual([...MAILBOXES, ...VIEW_MAILBOXES].sort());
    // The two views (1.4.0) are listable but are never where a message itself is.
    expect(VIEW_MAILBOXES.some((view) => isMailbox(view))).toBe(false);
  });
});

describe("recipientLines", () => {
  it("prints a named recipient as a header would, and a bare one as its address", () => {
    expect(formatContact({ name: "Ada Lovelace", address: "ada@example.com" })).toBe("Ada Lovelace <ada@example.com>");
    expect(formatContact({ address: "bob@example.com" })).toBe("bob@example.com");
    expect(formatContact({ name: "  ", address: "bob@example.com" })).toBe("bob@example.com");
    expect(formatContact({ name: "bob@example.com", address: "bob@example.com" })).toBe("bob@example.com");
  });

  it("gives one line per field with anyone in it, in to/cc/bcc order", () => {
    const lines = recipientLines(
      email({
        to: [{ name: "Ada", address: "ada@example.com" }, { address: "bob@example.com" }],
        bcc: [{ address: "eve@example.com" }],
        cc: [],
      }),
    );
    expect(lines).toEqual([
      { field: "to", text: "Ada <ada@example.com>, bob@example.com" },
      { field: "bcc", text: "eve@example.com" },
    ]);
  });

  it("is empty for a cached message that predates the recipient fields", () => {
    expect(recipientLines(email())).toEqual([]);
  });
});

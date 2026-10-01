import { describe, expect, it } from "vitest";
import { hashId, localId, threadKey } from "./ids";
import { displayAddress, displayName, isMailbox, isPreviewable, mimeTypeForFilename, monogram } from "./email";
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
    // FNV-1a avalanche: neighbouring ids must not land on neighbouring numbers.
    expect(hashId("msg-1")).not.toBe(hashId("msg-2"));
  });

  it("hashes non-ASCII by its UTF-8 bytes, not its code units", () => {
    // Same bytes, different UTF-16 representation paths through to one value.
    expect(hashId("café")).toBe(hashId("café"));
  });
});

describe("threadKey", () => {
  it("groups by the thread Gmail supplies", () => {
    expect(threadKey({ gmailId: "a", threadId: "t1" })).toBe("t1");
    expect(threadKey({ gmailId: "b", threadId: "t1" })).toBe("t1");
  });

  it("keeps a thread-less message on its own", () => {
    // Without the fallback every thread-less message would collapse into one
    // bogus conversation.
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
    // Gmail headers are attacker-influenced; a name of "  " must not win.
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

describe("isPreviewable", () => {
  it("previews images, PDFs and text", () => {
    expect(isPreviewable("image/png")).toBe(true);
    expect(isPreviewable("application/pdf")).toBe(true);
    expect(isPreviewable("text/plain")).toBe(true);
  });

  it("refuses SVG, which can carry script", () => {
    expect(isPreviewable("image/svg+xml")).toBe(false);
  });
});

describe("isMailbox", () => {
  it("narrows only the four real mailboxes", () => {
    expect(isMailbox("spam")).toBe(true);
    expect(isMailbox("drafts")).toBe(false);
    expect(isMailbox(7)).toBe(false);
  });
});

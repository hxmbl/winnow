/**
 * The raw message that goes out.
 *
 * Sending is the one thing in a mail client that cannot be undone, and it happens
 * through a hand-written MIME string that no other client will complain about in
 * advance. So these tests are mostly about the details a receiving client silently
 * ignores: line endings, header encoding, and — the two that actually broke
 * threading for the person on the other end — the `Message-ID` shape and the
 * alphabet the attachment body is written in.
 */

import { describe, expect, it } from "vitest";
import { buildMime, formatBytes, messageIdFor, replyReferences } from "./mime";
import { base64UrlDecode } from "./dto";
import type { Draft, Email } from "../model/email";

function draft(over: Partial<Draft> = {}): Draft {
  return {
    to: ["ada@example.com"],
    cc: [],
    bcc: [],
    subject: "Re: the plan",
    body: "Sounds good.",
    ...over,
  };
}

function email(over: Partial<Email> = {}): Email {
  return {
    id: 1,
    gmailId: "g1",
    messageId: "<CAM1@mail.gmail.com>",
    sender: "ada@example.com",
    mailbox: "inbox",
    receivedAt: Date.UTC(2026, 4, 9, 9, 30),
    subject: "the plan",
    body: "",
    category: "primary",
    starred: false,
    unread: false,
    attachments: [],
    urgent: false,
    ...over,
  };
}

/** Split a raw message into its header block and body at the first blank line. */
function split(raw: string): { headers: string[]; body: string } {
  const cut = raw.indexOf("\r\n\r\n");
  return { headers: raw.slice(0, cut).split("\r\n"), body: raw.slice(cut + 4) };
}

const headerOf = (raw: string, name: string): string | undefined =>
  split(raw)
    .headers.find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    ?.slice(name.length + 1)
    .trim();

describe("buildMime — the envelope", () => {
  it("addresses the recipient and signs as the account", () => {
    const raw = buildMime(draft(), { from: { address: "me@example.com", name: "me" } });
    expect(headerOf(raw, "To")).toBe("ada@example.com");
    expect(headerOf(raw, "From")).toBe("me <me@example.com>");
  });

  it("omits Cc and Bcc rather than sending empty headers", () => {
    const raw = buildMime(draft(), { from: { address: "me@example.com" } });
    expect(headerOf(raw, "Cc")).toBeUndefined();
    expect(headerOf(raw, "Bcc")).toBeUndefined();
  });

  it("includes them when there are any", () => {
    const raw = buildMime(draft({ cc: ["c@example.com"], bcc: ["b@example.com"] }), {
      from: { address: "me@example.com" },
    });
    expect(headerOf(raw, "Cc")).toBe("c@example.com");
    expect(headerOf(raw, "Bcc")).toBe("b@example.com");
  });

  it("declares MIME 1.0 and a plain-text body", () => {
    const raw = buildMime(draft(), { from: { address: "me@example.com" } });
    expect(headerOf(raw, "MIME-Version")).toBe("1.0");
    expect(headerOf(raw, "Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("uses CRLF throughout, because RFC 822 requires it", () => {
    // Gmail accepts LF-only raw and the body arrives as one joined line in some
    // clients. Nothing in the test suite would have caught that.
    const raw = buildMime(draft(), { from: { address: "me@example.com" } });
    expect(raw.includes("\n")).toBe(true);
    expect(raw.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("round-trips a non-ASCII body through its base64 transfer encoding", () => {
    const body = "Reunion à midi — ça marche ✓";
    const raw = buildMime(draft({ body }), { from: { address: "me@example.com" } });
    expect(headerOf(raw, "Content-Transfer-Encoding")).toBe("base64");
    expect(new TextDecoder().decode(base64UrlDecode(split(raw).body.replace(/\s+/g, "")) ?? new Uint8Array())).toBe(
      body,
    );
  });
});

describe("buildMime — headers that have to be encoded", () => {
  it("leaves an ASCII subject alone, so a debug read is legible", () => {
    const raw = buildMime(draft({ subject: "Re: the plan" }), { from: { address: "me@x.com" } });
    expect(headerOf(raw, "Subject")).toBe("Re: the plan");
  });

  it("RFC 2047 encodes a non-ASCII subject", () => {
    const raw = buildMime(draft({ subject: "Réunion — vendredi" }), {
      from: { address: "me@x.com" },
    });
    const subject = headerOf(raw, "Subject")!;
    expect(subject).toMatch(/^=\?UTF-8\?B\?/);
    expect(subject).not.toContain("é");
  });

  it("splits a long encoded subject so no word exceeds the 75-character limit", () => {
    const raw = buildMime(draft({ subject: "é".repeat(200) }), { from: { address: "me@x.com" } });
    for (const word of split(raw).headers.filter((l) => l.startsWith("Subject")).join("").split(" ")) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it("encodes a display name that is not ASCII", () => {
    const raw = buildMime(draft(), { from: { address: "me@x.com", name: "Zoë" } });
    expect(headerOf(raw, "From")).toMatch(/^=\?UTF-8\?B\?.* <me@x\.com>$/);
  });
});

describe("buildMime — threading", () => {
  it("answers the real Message-ID, not a bare Gmail id", () => {
    // This was the actual bug: `In-Reply-To: 18c1f3a2…`. Gmail threaded the reply
    // because Gmail matches on its own thread id, so it looked correct in the
    // sender's account and arrived as a new conversation in everyone else's.
    const raw = buildMime(draft(), {
      from: { address: "me@x.com" },
      inReplyTo: email(),
      references: [email({ gmailId: "g0", messageId: "<CAM0@mail.gmail.com>" })],
    });
    expect(headerOf(raw, "In-Reply-To")).toBe("<CAM1@mail.gmail.com>");
    expect(headerOf(raw, "References")).toBe("<CAM0@mail.gmail.com> <CAM1@mail.gmail.com>");
  });

  it("omits both headers for a new conversation", () => {
    const raw = buildMime(draft(), { from: { address: "me@x.com" } });
    expect(headerOf(raw, "In-Reply-To")).toBeUndefined();
    expect(headerOf(raw, "References")).toBeUndefined();
  });

  it("falls back to a synthesised id when the message carried none", () => {
    // Every demo message and every row cached by an older build. A synthesised id
    // still threads in Gmail; a bare id threads nowhere.
    const raw = buildMime(draft(), {
      from: { address: "me@x.com" },
      inReplyTo: email({ messageId: undefined }),
    });
    expect(headerOf(raw, "In-Reply-To")).toBe("<g1@mail.gmail.com>");
  });
});

describe("messageIdFor", () => {
  it("prefers the header the sender supplied", () => {
    expect(messageIdFor({ gmailId: "g1", messageId: "<abc@d>" })).toBe("<abc@d>");
  });

  it("synthesises one from the Gmail id otherwise", () => {
    expect(messageIdFor({ gmailId: "g1" })).toBe("<g1@mail.gmail.com>");
  });
});

describe("replyReferences", () => {
  it("runs oldest first, which is the order the header is defined to use", () => {
    // A client that walks it out of order treats the reply as belonging to
    // whichever message it saw last.
    const conversation = [
      email({ gmailId: "c", messageId: "<C@x>", receivedAt: 300 }),
      email({ gmailId: "a", messageId: "<A@x>", receivedAt: 100 }),
      email({ gmailId: "b", messageId: "<B@x>", receivedAt: 200 }),
    ];
    expect(replyReferences(conversation)).toEqual(["<A@x>", "<B@x>", "<C@x>"]);
  });

  it("does not reorder the caller's array", () => {
    const conversation = [
      email({ gmailId: "c", receivedAt: 300 }),
      email({ gmailId: "a", receivedAt: 100 }),
    ];
    replyReferences(conversation);
    expect(conversation.map((e) => e.gmailId)).toEqual(["c", "a"]);
  });

  it("skips a row with no Gmail id rather than writing an empty Message-ID", () => {
    expect(replyReferences([email({ gmailId: "" })])).toEqual([]);
  });
});

describe("buildMime — attachments", () => {
  it("switches to multipart and lists each file", () => {
    const raw = buildMime(draft(), {
      from: { address: "me@x.com" },
      attachments: [{ filename: "lease.pdf", bytes: new Uint8Array([1, 2, 3, 4]) }],
    });
    expect(headerOf(raw, "Content-Type")).toMatch(/^multipart\/mixed; boundary="winnow-/);
    expect(raw).toContain("Content-Disposition: attachment; filename=\"lease.pdf\"");
  });

  it("guesses the content type from the extension", () => {
    const raw = buildMime(draft(), {
      from: { address: "me@x.com" },
      attachments: [{ filename: "notes.txt", bytes: new Uint8Array([65]) }],
    });
    expect(raw).toContain("Content-Type: text/plain; name=\"notes.txt\"");
  });

  it("falls back to octet-stream for an extension it does not know", () => {
    const raw = buildMime(draft(), {
      from: { address: "me@x.com" },
      attachments: [{ filename: "thing.wibble", bytes: new Uint8Array([65]) }],
    });
    expect(raw).toContain("Content-Type: application/octet-stream; name=\"thing.wibble\"");
  });

  it("writes the attachment body in standard base64, not base64url", () => {
    // `Content-Transfer-Encoding: base64` is decoded with the RFC 2045 alphabet by
    // every receiving client, and `-`/`_` are not in it. Bytes chosen to produce
    // both, which the url-safe encoding would have turned into `-` and `_`.
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf]);
    const raw = buildMime(draft(), {
      from: { address: "me@x.com" },
      attachments: [{ filename: "x.bin", bytes }],
    });
    // The first line after the attachment's transfer-encoding header, which is the
    // body — the closing boundary below it is of course full of dashes.
    const body = raw
      .slice(raw.lastIndexOf("Content-Transfer-Encoding: base64") + 36)
      .trim()
      .split("\r\n")[0];
    expect(body).not.toMatch(/[-_]/);
    expect(new Uint8Array([...atob(body)].map((c) => c.charCodeAt(0)))).toEqual(bytes);
  });

  it("closes the multipart body", () => {
    const raw = buildMime(draft(), {
      from: { address: "me@x.com" },
      attachments: [{ filename: "a.bin", bytes: new Uint8Array([1]) }],
    });
    expect(raw.trimEnd().endsWith("--")).toBe(true);
    expect(raw).toMatch(/--winnow-[a-z0-9]+--\s*$/);
  });
});

describe("formatBytes", () => {
  it("reads the way mail clients do", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });

  it("stops at gigabytes rather than inventing a unit", () => {
    expect(formatBytes(4096 * 1024 * 1024 * 1024)).toBe("4096 GB");
  });
});

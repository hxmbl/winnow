import { describe, expect, it } from "vitest";
import {
  attributionLine,
  buildForward,
  buildReply,
  forwardSubject,
  isIntactSuffix,
  quoteBlockFor,
  quotedBody,
  replySubject,
  stripQuote,
} from "./reply";
import { plainTextFromHtml, decodeEntities, sanitizeDisplayName, parseAddressHeader } from "./html";
import type { Email } from "../model/email";

function email(over: Partial<Email> = {}): Email {
  return {
    id: 1,
    gmailId: "g1",
    threadId: "t1",
    sender: "ada@example.com",
    name: "Ada Lovelace",
    mailbox: "inbox",
    receivedAt: Date.UTC(2026, 4, 9, 9, 30),
    subject: "The plan",
    body: "First line.\n\nSecond paragraph.",
    category: "primary",
    starred: false,
    unread: false,
    attachments: [],
    urgent: false,
    ...over,
  };
}

describe("quotedBody", () => {
  it("prefixes every line", () => {
    expect(quotedBody("one\ntwo")).toBe("> one\n> two");
  });

  it("renders an empty line as a bare marker with no trailing space", () => {
    // A trailing space survives into the sent message and shows up as a stray
    // blank line in every client the recipient uses.
    expect(quotedBody("one\n\ntwo")).toBe("> one\n>\n> two");
    for (const line of quotedBody("one\n\ntwo").split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it("preserves a trailing newline as a trailing empty line", () => {
    expect(quotedBody("one\n")).toBe("> one\n>");
  });

  it("handles an empty body", () => {
    expect(quotedBody("")).toBe("");
  });
});

describe("attributionLine", () => {
  it("names the sender and the time", () => {
    const line = attributionLine(email());
    expect(line).toMatch(/^On .+, Ada Lovelace wrote:$/);
  });

  it("falls back to the address when there is no name", () => {
    expect(attributionLine(email({ name: undefined }))).toContain("ada");
  });
});

describe("quoteBlockFor", () => {
  it("strips the HTML when there is no plain text", () => {
    // Webmail clients routinely send `text/html` only. Without this fallback
    // the quote would be empty and the reply would lose its context entirely.
    const htmlOnly = email({ body: "", bodyHtml: "<p>Hello</p><p>World</p>" });
    const block = quoteBlockFor(htmlOnly);
    expect(block).toContain("> Hello");
    expect(block).toContain("> World");
    expect(block).not.toContain("<p>");
  });

  it("prefers the plain text when both exist", () => {
    const both = email({ body: "Plain version", bodyHtml: "<p>HTML version</p>" });
    expect(quoteBlockFor(both)).toContain("> Plain version");
  });
});

describe("isIntactSuffix", () => {
  it("is true only when the block is still the untouched end of the body", () => {
    expect(isIntactSuffix("reply\n> quoted", "> quoted")).toBe(true);
  });

  it("is false when the user edited the quoted text itself", () => {
    // A `startsWith` check would silently delete the user's edits. The quote
    // only leaves as a byte-for-byte suffix — note the block here is the *whole*
    // original quote, so a body that kept the text but changed a word no
    // longer ends with it.
    const block = "> On Tuesday, Ada wrote:\n> Hello";
    expect(isIntactSuffix(`reply\n${block}`, block)).toBe(true);
    expect(isIntactSuffix("reply\n> On Tuesday, Ada wrote:\n> Hello there", block)).toBe(false);
  });

  it("is false when the user typed after the quote", () => {
    const block = "> Hello";
    expect(isIntactSuffix(`reply\n${block}\nand one more thing`, block)).toBe(false);
  });

  it("is false for an empty block", () => {
    // An empty block matches every string as a suffix, so a user who cleared
    // the composer would have that read as "the quote is intact".
    expect(isIntactSuffix("anything", "")).toBe(false);
    expect(isIntactSuffix("anything", undefined)).toBe(false);
  });
});

describe("stripQuote", () => {
  it("removes an untouched quote", () => {
    const block = "> On Tuesday, Ada wrote:\n> Hello";
    expect(stripQuote(`My answer.\n\n${block}`, block)).toBe("My answer.\n\n");
  });

  it("leaves an edited quote alone", () => {
    const block = "> On Tuesday, Ada wrote:\n> Hello";
    const edited = "My answer.\n\n> On Tuesday, Ada wrote:\n> Hello there";
    expect(stripQuote(edited, block)).toBe(edited);
  });

  it("leaves a quote alone when text was added after it", () => {
    const block = "> Hello";
    const body = `My answer.\n\n${block}\nand one more thing`;
    expect(stripQuote(body, block)).toBe(body);
  });
});

describe("subjects", () => {
  it("prefixes Re: once", () => {
    expect(replySubject("The plan")).toBe("Re: The plan");
    expect(replySubject("Re: The plan")).toBe("Re: The plan");
  });

  it("does not double the prefix whatever the case", () => {
    // Clients disagree about case, and treating `RE:` as unprefixed produced
    // `Re: RE: Re: …` over a long thread.
    for (const subject of ["RE: The plan", "re: the plan", "Re: The plan"]) {
      expect(replySubject(subject)).toBe(subject);
    }
  });

  it("prefixes Fwd: once", () => {
    expect(forwardSubject("The plan")).toBe("Fwd: The plan");
    expect(forwardSubject("Fwd: The plan")).toBe("Fwd: The plan");
  });

  it("keeps an already-prefixed subject's own casing", () => {
    expect(replySubject("RE: the plan")).toBe("RE: the plan");
  });
});

describe("buildReply", () => {
  it("addresses the last sender", () => {
    const thread = [email({ sender: "a@x.com" }), email({ sender: "b@x.com", receivedAt: 1 })];
    const draft = buildReply(thread[1], thread);
    expect(draft.to).toEqual(["b@x.com"]);
  });

  it("includes everyone on reply-all, minus yourself", () => {
    const thread = [
      email({ sender: "a@x.com" }),
      email({ sender: "b@x.com", receivedAt: 1 }),
      email({ sender: "me@northwind.example", receivedAt: 2 }),
    ];
    const draft = buildReply(thread[2], thread, {
      replyAll: true,
      selfAddress: "me@northwind.example",
    });
    expect(draft.to.sort()).toEqual(["a@x.com", "b@x.com"]);
  });

  it("carries the thread so the reply lands in the conversation", () => {
    const draft = buildReply(email(), [email()]);
    expect(draft.threadId).toBe("t1");
    expect(draft.inReplyTo).toBe("g1");
  });

  it("keeps the quote block so it can be stripped if untouched", () => {
    const original = email();
    const draft = buildReply(original, [original]);
    // Stripping the pre-filled quote must leave the composer empty, not leave
    // the attribution stranded on its own — which is what happens if the
    // template's own newlines are counted as part of the block.
    expect(draft.quoteBlock).toBeDefined();
    expect(stripQuote(draft.body, draft.quoteBlock).trim()).toBe("");
  });

  it("strips cleanly when the user typed above an untouched quote", () => {
    const original = email();
    const draft = buildReply(original, [original]);
    const typed = `My answer.\n${draft.body}`;
    // The user's own words survive and only the quote goes: the quote is still
    // byte-for-byte the end of the body, so it was never edited and is safe to
    // remove. What must never happen is losing the text the user wrote.
    const stripped = stripQuote(typed, draft.quoteBlock);
    expect(stripped).toBe("My answer.\n");
    expect(stripped).toContain("My answer.");
  });
});

describe("buildForward", () => {
  it("includes every message in the thread with its attribution", () => {
    const thread = [
      email({ gmailId: "g1", receivedAt: 1 }),
      email({ gmailId: "g2", receivedAt: 2 }),
    ];
    const draft = buildForward(thread[1], thread, ["someone@else.com"]);
    expect(draft.to).toEqual(["someone@else.com"]);
    expect(draft.body).toContain("Ada Lovelace wrote:");
    expect(draft.body).toContain("First line.");
  });
});

describe("plainTextFromHtml", () => {
  it("drops script contents, not just the tags", () => {
    // Reversing these two steps leaves JavaScript source in the middle of a
    // quoted reply, which is both ugly and a phishing tell in itself.
    const text = plainTextFromHtml("<p>Hello</p><script>alert('x')</script><p>World</p>");
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text).not.toContain("alert");
  });

  it("drops style and head contents", () => {
    const text = plainTextFromHtml(
      "<head><style>body{color:red}</style></head><p>Visible</p>",
    );
    expect(text).toBe("Visible");
  });

  it("turns block ends into newlines", () => {
    expect(plainTextFromHtml("<p>One</p><p>Two</p>")).toBe("One\nTwo");
    expect(plainTextFromHtml("One<br>Two")).toBe("One\nTwo");
  });

  it("collapses runs of blank lines to a paragraph break", () => {
    expect(plainTextFromHtml("One<br><br><br><br>Two")).toBe("One\n\nTwo");
  });

  it("decodes entities", () => {
    expect(plainTextFromHtml("<p>Tom &amp; Jerry &mdash; &#8220;quoted&#8221;</p>")).toBe(
      "Tom & Jerry — “quoted”",
    );
  });

  it("leaves an unrecognised entity alone rather than eating it", () => {
    // Dropping it would corrupt ordinary text that happened to be escaped oddly.
    expect(decodeEntities("AT&T and &notanentity; and &#x41;")).toBe("AT&T and &notanentity; and A");
  });

  it("does not throw on a malformed numeric entity", () => {
    // `String.fromCodePoint(NaN)` throws, inside a render.
    expect(() => decodeEntities("&#notanumber;")).not.toThrow();
  });

  it("handles an empty string", () => {
    expect(plainTextFromHtml("")).toBe("");
  });
});

describe("sanitizeDisplayName", () => {
  it("strips zero-width and bidi characters", () => {
    // A name containing a bidi override renders as a different name than it
    // is: the visible text reads "GitHub Support" while the code points carry
    // a right-to-left override that reorders what a human sees. This is the
    // oldest trick in display-name spoofing.
    const spoofed = "GitHub Support\u202E";
    const clean = sanitizeDisplayName(spoofed);
    expect(clean).toBe("GitHub Support");
    expect(clean).not.toContain("\u202E");
  });

  it("strips zero-width joiners and non-joiners", () => {
    // A zero-width character in the middle of a name breaks naive equality
    // checks, so "ada\u200b@example.com" and "ada@example.com" compare
    // differently while looking identical.
    expect(sanitizeDisplayName("A\u200bda")).toBe("Ada");
    expect(sanitizeDisplayName("A\u200dda")).toBe("Ada");
  });

  it("strips control characters", () => {
    // A NUL in a header value truncates the string in some parsers, so
    // everything after it would vanish from the byline.
    expect(sanitizeDisplayName("A\u0000da")).toBe("Ada");
    expect(sanitizeDisplayName("A\u0007da")).toBe("Ada");
  });

  it("leaves ordinary non-ASCII names alone", () => {
    // The sanitiser must not quietly become a transliterator — a name in any
    // script is a legitimate name, and mangling it would be a visible bug in
    // exactly the case the sanitiser exists to protect.
    expect(sanitizeDisplayName("Ada Lovelace")).toBe("Ada Lovelace");
    expect(sanitizeDisplayName("\u4E2D\u5927 花子")).toBe("\u4E2D\u5927 花子");
    expect(sanitizeDisplayName("Zo\u00EB M\u00FCller")).toBe("Zo\u00EB M\u00FCller");
  });

  it("collapses whitespace", () => {
    expect(sanitizeDisplayName("  Ada   Lovelace  ")).toBe("Ada Lovelace");
  });

  it("caps the length, so a name cannot push the address off screen", () => {
    expect(sanitizeDisplayName("A".repeat(500))).toHaveLength(128);
  });
});

describe("parseAddressHeader", () => {
  it("splits a display name from the address", () => {
    expect(parseAddressHeader("Ada Lovelace <ada@example.com>")).toEqual({
      name: "Ada Lovelace",
      address: "ada@example.com",
    });
  });

  it("handles a quoted display name", () => {
    expect(parseAddressHeader('"Lovelace, Ada" <ada@example.com>')).toEqual({
      name: "Lovelace, Ada",
      address: "ada@example.com",
    });
  });

  it("returns the address alone when there is no name", () => {
    expect(parseAddressHeader("ada@example.com")).toEqual({ address: "ada@example.com" });
  });

  it("returns null for something that is not an address", () => {
    expect(parseAddressHeader("not an address")).toBeNull();
    expect(parseAddressHeader("")).toBeNull();
  });

  it("sanitises the name it extracts", () => {
    expect(parseAddressHeader("Ada  <ada@example.com>")?.name).toBe("Ada");
  });
});

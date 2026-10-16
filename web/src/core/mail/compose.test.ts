import { describe, expect, it } from "vitest";
import {
  buildNewDraft,
  draftFromMailto,
  isUntouchedNewDraft,
  needsSubjectConfirmation,
  normaliseRecipients,
  recipientProblem,
} from "./compose";
import { buildMime } from "../gmail/mime";

/** The header block of a raw message, unfolded, keyed by lowercase name. */
function headers(raw: string): Map<string, string> {
  const head = raw.split("\r\n\r\n")[0].replace(/\r\n /g, " ");
  const out = new Map<string, string>();
  for (const line of head.split("\r\n")) {
    const colon = line.indexOf(":");
    out.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return out;
}

/** Decode every RFC 2047 base64 word in a header value. */
function decodeWords(value: string): string {
  return value
    .split(" ")
    .map((word) => {
      const match = /^=\?UTF-8\?B\?(.*)\?=$/.exec(word);
      if (!match) return word;
      const binary = atob(match[1]);
      return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    })
    .join("");
}

const FROM = { address: "alex@northwind.example", name: "alex" };

describe("a new draft", () => {
  it("starts blank, with nothing tying it to a conversation", () => {
    const draft = buildNewDraft();
    expect(draft).toEqual({ to: [], cc: [], bcc: [], subject: "", body: "", prefilled: "" });
    expect(draft.inReplyTo).toBeUndefined();
    expect(draft.threadId).toBeUndefined();
    expect(draft.quoteBlock).toBeUndefined();
  });

  it("builds a message with no threading headers", () => {
    const draft = { ...buildNewDraft(), to: ["dana@northwind.example"], subject: "Hello", body: "Hi" };
    const raw = buildMime(draft, { from: FROM });
    const h = headers(raw);
    expect(h.has("in-reply-to")).toBe(false);
    expect(h.has("references")).toBe(false);
    expect(h.get("to")).toBe("dana@northwind.example");
    expect(h.get("from")).toBe("alex <alex@northwind.example>");
    expect(h.get("subject")).toBe("Hello");
    expect(h.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(h.get("content-transfer-encoding")).toBe("base64");
    expect(h.get("message-id")).toMatch(/^<winnow-.+@winnow\.app>$/);
  });

  it("carries Cc and Bcc only when they have someone", () => {
    const bare = headers(buildMime({ ...buildNewDraft(), to: ["a@b.example"] }, { from: FROM }));
    expect(bare.has("cc")).toBe(false);
    expect(bare.has("bcc")).toBe(false);

    const full = headers(
      buildMime(
        { ...buildNewDraft(), to: ["a@b.example"], cc: ["c@d.example", "e@f.example"], bcc: ["g@h.example"] },
        { from: FROM },
      ),
    );
    expect(full.get("cc")).toBe("c@d.example, e@f.example");
    expect(full.get("bcc")).toBe("g@h.example");
  });

  it("encodes a non-ASCII subject as RFC 2047 words, and the body as UTF-8 base64", () => {
    const subject = "Café crème — 日本語のテストの件名、少し長めにしてみます";
    const body = "Grüße, Zoë ✓";
    const raw = buildMime({ ...buildNewDraft(), to: ["a@b.example"], subject, body }, { from: FROM });
    const h = headers(raw);
    expect(h.get("subject")).toMatch(/^=\?UTF-8\?B\?/);
    for (const word of h.get("subject")!.split(" ")) expect(word.length).toBeLessThanOrEqual(75);
    expect(decodeWords(h.get("subject")!)).toBe(subject);

    const encodedBody = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    const bytes = Uint8Array.from(atob(encodedBody), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(body);
  });

  it("keeps the starting body as the baseline for the discard question", () => {
    const draft = buildNewDraft({ body: "From a link" });
    expect(draft.prefilled).toBe("From a link");
    expect(isUntouchedNewDraft(draft, draft)).toBe(true);
    expect(isUntouchedNewDraft({ ...draft, body: "From a link, edited" }, draft)).toBe(false);
  });

  it("counts recipients and the subject as written", () => {
    const initial = buildNewDraft();
    expect(isUntouchedNewDraft(initial, initial)).toBe(true);
    expect(isUntouchedNewDraft({ ...initial, to: ["a@b.example"] }, initial)).toBe(false);
    expect(isUntouchedNewDraft({ ...initial, bcc: ["a@b.example"] }, initial)).toBe(false);
    expect(isUntouchedNewDraft({ ...initial, subject: "Hi" }, initial)).toBe(false);
    expect(isUntouchedNewDraft({ ...initial, subject: "   " }, initial)).toBe(true);
    expect(isUntouchedNewDraft({ ...initial, body: "x" }, initial)).toBe(false);
  });
});

describe("recipients", () => {
  it("accepts commas, semicolons and display names", () => {
    expect(
      normaliseRecipients(["Ada Lovelace <ada@example.com>; grace@example.com, \"Hopper, G\" <g@example.com>"]),
    ).toEqual(["ada@example.com", "grace@example.com", "g@example.com"]);
  });

  it("keeps what is not an address, so it shows as wrong rather than vanishing", () => {
    expect(normaliseRecipients(["not an address", "a@b.example"])).toEqual(["not an address", "a@b.example"]);
  });

  it("drops duplicates, whatever their case", () => {
    expect(normaliseRecipients(["a@b.example", "A@B.example", "Ada <a@b.example>"])).toEqual(["a@b.example"]);
  });

  it("blocks a draft with nobody on it", () => {
    expect(recipientProblem(buildNewDraft())).toBe("none");
  });

  it("blocks a draft with anything that is not an address", () => {
    expect(recipientProblem({ to: ["a@b.example"], cc: ["oops"], bcc: [] })).toBe("invalid");
    expect(recipientProblem({ to: ["a@"], cc: [], bcc: [] })).toBe("invalid");
    expect(recipientProblem({ to: ["a@localhost"], cc: [], bcc: [] })).toBe("invalid");
  });

  it("sends with a valid address in any of To, Cc or Bcc", () => {
    expect(recipientProblem({ to: ["a@b.example"], cc: [], bcc: [] })).toBeNull();
    expect(recipientProblem({ to: [], cc: ["a@b.example"], bcc: [] })).toBeNull();
    expect(recipientProblem({ to: [], cc: [], bcc: ["a@b.example"] })).toBeNull();
  });
});

describe("the subject", () => {
  it("asks before sending without one", () => {
    expect(needsSubjectConfirmation({ subject: "" })).toBe(true);
    expect(needsSubjectConfirmation({ subject: "  \t" })).toBe(true);
    expect(needsSubjectConfirmation({ subject: "Hello" })).toBe(false);
  });
});

describe("mailto:", () => {
  it("reads the path, the recipients and the fields RFC 6068 names", () => {
    const draft = draftFromMailto(
      "mailto:ada@example.com,grace@example.com?cc=c%40d.example&bcc=e@f.example&subject=Hello%20there&body=Line%201%0D%0ALine%202",
    );
    expect(draft).toMatchObject({
      to: ["ada@example.com", "grace@example.com"],
      cc: ["c@d.example"],
      bcc: ["e@f.example"],
      subject: "Hello there",
      body: "Line 1\nLine 2",
      prefilled: "Line 1\nLine 2",
    });
    expect(draft?.inReplyTo).toBeUndefined();
    expect(draft?.threadId).toBeUndefined();
  });

  it("takes recipients from the query when the path is empty, and is case-blind", () => {
    expect(draftFromMailto("MAILTO:?To=a@b.example&SUBJECT=Hi")).toMatchObject({ to: ["a@b.example"], subject: "Hi" });
  });

  it("ignores headers a link may not set", () => {
    const draft = draftFromMailto("mailto:a@b.example?from=evil@x.example&in-reply-to=%3Cx%3E");
    expect(draft).toEqual(buildNewDraft({ to: ["a@b.example"] }));
  });

  it("survives a malformed escape, and refuses anything else", () => {
    expect(draftFromMailto("mailto:a@b.example?subject=100%")?.subject).toBe("100%");
    expect(draftFromMailto("https://example.com")).toBeNull();
  });
});

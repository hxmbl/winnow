/**
 * Dev Options → Pure Plain Text: every piece the normal Plain text form removes is
 * there with the switch on, and gone with it off.
 */

import { describe, expect, it } from "vitest";
import { bodyIsExtractedFromHtml, plainTextForReading } from "./plainView";
import { literalTextFromHtml, plainTextFromHtml } from "./html";
import { toEmail, loadedBodyOf } from "../gmail/mapper";
import { keepLoadedBody, withLoadedBody, type Email } from "../model/email";
import { LABEL, type GmailMessage, type GmailPart } from "../gmail/dto";

/** base64url, the way Gmail sends it. */
function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function leaf(mimeType: string, text: string): GmailPart {
  return { mimeType, body: { data: b64(text), size: text.length } };
}

function gmail(parts: GmailPart[]): GmailMessage {
  return {
    id: "m1",
    threadId: "t1",
    labelIds: [LABEL.inbox],
    internalDate: "1700000000000",
    snippet: "snippet",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Sender <sender@example.com>" },
        { name: "Subject", value: "Hello" },
      ],
      parts,
    },
  } as GmailMessage;
}

function mapped(parts: GmailPart[]): Email {
  const email = toEmail(gmail(parts));
  if (!email) throw new Error("not mapped");
  return email;
}

const read = (email: Email, pure: boolean) => plainTextForReading(email, { pure });

/**
 * A `text/plain` part carrying every kind of thing `tidyPlainText` removes, each one
 * named so a failure says which.
 */
const PLAIN_PIECES = {
  leadingBlankLines: "\n\n",
  preheaderFiller: "Preview\u034f\u00a0\u034f\u00a0\u200b\u2060\ufeff\u180e\u00ad\n",
  fillerEntities: "Entities&shy;&#847;&#8203;&#xfeff;here\n",
  whitespaceOnlyLine: "   \t  \n",
  blankLineRun: "Para one\n\n\n\n\nPara two\n",
  trailingBlankLines: "Bye\n\n\n",
};
const PLAIN = Object.values(PLAIN_PIECES).join("");

describe("Pure Plain Text, for a message with a text/plain part", () => {
  const email = mapped([leaf("text/plain", PLAIN), leaf("text/html", "<p>Rich</p>")]);

  it("records that the body is the sender's own plain part", () => {
    expect(email.bodySource).toBe("plain");
    expect(bodyIsExtractedFromHtml(email)).toBe(false);
  });

  it("on: shows the part byte for byte", () => {
    expect(read(email, true)).toBe(PLAIN);
  });

  it("on: keeps the leading blank lines", () => {
    expect(read(email, true).startsWith(PLAIN_PIECES.leadingBlankLines + "Preview")).toBe(true);
    expect(read(email, false).startsWith("Preview")).toBe(true);
  });

  it("on: keeps the invisible preheader filler; off removes it", () => {
    for (const char of ["\u034f", "\u200b", "\u2060", "\ufeff", "\u180e", "\u00ad"]) {
      expect(read(email, true)).toContain(char);
      expect(read(email, false)).not.toContain(char);
    }
  });

  it("on: keeps filler written as entities; off removes it", () => {
    expect(read(email, true)).toContain("Entities&shy;&#847;&#8203;&#xfeff;here");
    expect(read(email, false)).toContain("Entitieshere");
  });

  it("on: keeps a line of nothing but spaces; off empties it", () => {
    expect(read(email, true)).toContain("\n   \t  \n");
    expect(read(email, false)).not.toMatch(/^[ \t]+$/m);
  });

  it("on: keeps a run of blank lines; off collapses it to one", () => {
    expect(read(email, true)).toContain("Para one\n\n\n\n\nPara two");
    expect(read(email, false)).toContain("Para one\n\nPara two");
  });

  it("on: keeps the trailing blank lines; off drops them", () => {
    expect(read(email, true).endsWith("Bye\n\n\n")).toBe(true);
    expect(read(email, false).endsWith("Bye")).toBe(true);
  });

  it("keeps CRLF line ends exactly as sent", () => {
    const crlf = mapped([leaf("text/plain", "One\r\n\r\n\r\nTwo\r\n")]);
    expect(read(crlf, true)).toBe("One\r\n\r\n\r\nTwo\r\n");
  });
});

/** An HTML-only message with everything `plainTextFromHtml` cleans away. */
const HTML = [
  "",
  "<html><head><title>Page title</title><style>.x { color: red; }</style></head>",
  "<body>",
  "<!--[if mso]>Outlook only<![endif]-->",
  "<script>var tracked = 1;</script>",
  '<div style="display:none">Preheader&#847;&nbsp;&#847;&nbsp;&shy;</div>',
  "<p>   Indented line   </p>",
  "<p>First</p>\n\n\n\n<p>Second &lt;b&gt;not bold&lt;/b&gt;</p>",
  "</body></html>",
].join("\n");

describe("Pure Plain Text, for a message with only an HTML part", () => {
  const email = mapped([leaf("text/html", HTML)]);

  it("records that the body was extracted from the HTML", () => {
    expect(email.bodySource).toBe("html");
    expect(bodyIsExtractedFromHtml(email)).toBe(true);
  });

  it("on: keeps the <head>'s title and the <style> and <script> contents; off drops them", () => {
    for (const kept of ["Page title", ".x { color: red; }", "var tracked = 1;"]) {
      expect(read(email, true)).toContain(kept);
      expect(read(email, false)).not.toContain(kept);
    }
  });

  it("on: keeps indentation and spaces at line ends; off trims them", () => {
    expect(read(email, true)).toContain("   Indented line   \n");
    expect(read(email, false)).toContain("\nIndented line\n");
  });

  it("on: keeps the sender's blank lines; off collapses them", () => {
    expect(read(email, true)).toMatch(/First\n\n\n\n\nSecond/);
    expect(read(email, false)).toMatch(/First\n\nSecond/);
  });

  it("on: keeps the preheader's filler; off removes it", () => {
    expect(read(email, true)).toContain("Preheader\u034f\u00a0\u034f\u00a0\u00ad");
    expect(read(email, false)).not.toContain("\u034f");
  });

  it("on: keeps the leading and trailing whitespace; off trims it", () => {
    expect(read(email, true).startsWith("\nPage title")).toBe(true);
    expect(read(email, true).endsWith("not bold</b>\n\n")).toBe(true);
    expect(read(email, false).startsWith("Outlook only")).toBe(true);
    expect(read(email, false).endsWith("not bold</b>")).toBe(true);
  });

  it("is still text either way: tags are markup, not words", () => {
    for (const pure of [true, false]) {
      expect(read(email, pure)).not.toMatch(/<\/?(p|div|html|body|head|style|script|title)\b/);
      expect(read(email, pure)).not.toContain("<!--");
      // What the normal form shows of an Outlook conditional comment, pure shows too.
      expect(read(email, pure)).toContain("Outlook only");
    }
    // An escaped tag in the message is the sender's words and comes out as words, which
    // the reader renders as a text node.
    expect(read(email, true)).toContain("Second <b>not bold</b>");
  });

  it("falls back to the extracted body until the HTML is resident", () => {
    expect(read({ ...email, bodyHtml: undefined }, true)).toBe(email.body);
  });
});

describe("Pure Plain Text, elsewhere", () => {
  it("shows a metadata row's snippet as it is", () => {
    const snippet = { body: "  snippet\u200b  ", bodySource: "snippet" as const };
    expect(read(snippet as Email, true)).toBe("  snippet\u200b  ");
  });

  it("works out an old cache row's source: extracted HTML is recognised", () => {
    const html = "<p>Hi</p>\n\n\n\n<p>There</p>";
    const extracted = { body: plainTextFromHtml(html), bodyHtml: html } as Email;
    expect(bodyIsExtractedFromHtml(extracted)).toBe(true);
    expect(read(extracted, true)).toBe(literalTextFromHtml(html));
    const ownText = { body: "Hi\n\n\n\nThere", bodyHtml: html } as Email;
    expect(bodyIsExtractedFromHtml(ownText)).toBe(false);
    expect(read(ownText, true)).toBe("Hi\n\n\n\nThere");
  });

  it("carries the body's source through lazy loading and re-syncs", () => {
    const full = gmail([leaf("text/plain", PLAIN)]);
    const loaded = loadedBodyOf(full);
    expect(loaded.bodySource).toBe("plain");
    const meta = toEmail(full, { format: "metadata" })!;
    expect(meta.bodySource).toBe("snippet");
    const applied = withLoadedBody(meta, loaded);
    expect(applied.bodySource).toBe("plain");
    expect(keepLoadedBody(meta, applied).bodySource).toBe("plain");
  });

  it("off is exactly what Plain text showed before the switch existed", () => {
    const email = mapped([leaf("text/plain", PLAIN)]);
    expect(read(email, false)).toBe("Preview\u00a0\u00a0\nEntitieshere\n\nPara one\n\nPara two\nBye");
  });
});

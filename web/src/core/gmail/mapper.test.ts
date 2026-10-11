/**
 * Gmail's wire format → Winnow's `Email`.
 *
 * Tests cover sender-controlled edge cases: unparseable `From`, display name
 * carrying bidi overrides, encoded-word subjects, payloads with no text part,
 * inline signature logos counted as attachments, and `Date:` disagreeing with
 * `internalDate`.
 */

import { describe, expect, it } from "vitest";
import {
  decodeBody,
  decodeMimeWord,
  headerValue,
  mailboxFor,
  messageIdHeader,
  parseDateHeader,
  toEmail,
} from "./mapper";
import { LABEL, type GmailMessage, type GmailPart } from "./dto";

/** base64url, the way Gmail sends it. */
function b64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function part(over: Partial<GmailPart> = {}): GmailPart {
  return { mimeType: "text/plain", body: { data: b64("hello"), size: 5 }, ...over };
}

function message(over: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: "m1",
    threadId: "t1",
    labelIds: [LABEL.inbox],
    internalDate: "1770000000000",
    snippet: "a snippet",
    payload: part({
      headers: [
        { name: "From", value: "Ada Lovelace <ada@example.com>" },
        { name: "Subject", value: "The plan" },
      ],
    }),
    ...over,
  };
}

describe("mailboxFor", () => {
  it("prefers trash over everything, because that is where the user gets rid of it", () => {
    expect(mailboxFor([LABEL.inbox, LABEL.spam, LABEL.trash])).toBe("trash");
  });

  it("then spam over inbox, for the same reason", () => {
    expect(mailboxFor([LABEL.inbox, LABEL.spam])).toBe("spam");
  });

  it("files an unlabelled message as archived", () => {
    expect(mailboxFor([])).toBe("archive");
    expect(mailboxFor([LABEL.starred, LABEL.important])).toBe("archive");
  });
});

describe("headerValue", () => {
  it("matches the name case-insensitively", () => {
    const part = { headers: [{ name: "content-id", value: "abc" }] };
    expect(headerValue(part, "Content-ID")).toBe("abc");
  });

  it("is undefined rather than empty for a header that is not there", () => {
    // The caller distinguishes "absent" from "present but blank": an absent `From`
    // gets a placeholder, a blank one does not.
    expect(headerValue(undefined, "From")).toBeUndefined();
    expect(headerValue({ headers: [] }, "From")).toBeUndefined();
  });

  it("takes the first match, not the last", () => {
    const part = {
      headers: [
        { name: "X", value: "first" },
        { name: "x", value: "second" },
      ],
    };
    expect(headerValue(part, "X")).toBe("first");
  });
});

describe("decodeMimeWord", () => {
  it("decodes a base64 encoded-word", () => {
    expect(decodeMimeWord("=?UTF-8?B?VGhlIHBsYW4=?=")).toBe("The plan");
  });

  it("decodes a quoted-printable encoded-word", () => {
    expect(decodeMimeWord("=?UTF-8?Q?Two_words?=")).toBe("Two words");
  });

  it("decodes a multi-byte character rather than three Latin-1 ones", () => {
    // `=E2=80=94` is an em dash in UTF-8; read byte-by-byte it would render
    // as three characters (mojibake).
    expect(decodeMimeWord("=?UTF-8?Q?Invoice_=E2=80=94_0412?=")).toBe("Invoice — 0412");
  });

  it("decodes an accented subject", () => {
    expect(decodeMimeWord("=?UTF-8?Q?R=C3=A9union?=")).toBe("Réunion");
  });

  it("assembles bytes split by unescaped ASCII", () => {
    expect(decodeMimeWord("=?UTF-8?Q?caf=C3=A9_at_3pm?=")).toBe("café at 3pm");
  });

  it("leaves plain text alone", () => {
    expect(decodeMimeWord("Plain subject")).toBe("Plain subject");
    expect(decodeMimeWord("Re: =?not really?=")).toBe("Re: =?not really?=");
  });

  it("keeps the encoded word rather than losing the subject when it cannot decode", () => {
    const broken = "=?UTF-8?B?not base64 at all!!?=";
    expect(decodeMimeWord(broken)).toBe(broken);
  });

  it("decodes each word in a subject, which is how long subjects arrive", () => {
    // Subjects over the RFC's 75-character limit arrive split into encoded words
    // separated by whitespace that is layout, not content. Keeping that space put
    // a duplicate space in the middle of the subject.
    const encoded = ["=?UTF-8?Q?Your_invoice?=", " ", "=?UTF-8?Q?_=E2=80=94_=E2=82=AC?="].join("");
    expect(decodeMimeWord(encoded)).toBe("Your invoice — €");
  });

  it("keeps a space that is real content rather than word layout", () => {
    // The same separator between an encoded word and plain text is a real space.
    expect(decodeMimeWord("=?UTF-8?Q?R=C3=A9union?= du vendredi")).toBe("Réunion du vendredi");
  });
});

describe("decodeBody", () => {
  it("decodes base64url, including the `-` and `_` alphabet", () => {
    expect(decodeBody(b64("Hi — there ✓"))).toBe("Hi — there ✓");
  });

  it("returns empty rather than throwing on input atob rejects", () => {
    // The headers still classify the message and the snippet still previews it;
    // a bad body is a worse row, not no row.
    expect(decodeBody("!!!not base64!!!")).toBe("");
  });
});

describe("parseDateHeader", () => {
  it("falls back when the header is absent or unparseable", () => {
    expect(parseDateHeader(undefined, 7)).toBe(7);
    expect(parseDateHeader("not a date", 7)).toBe(7);
  });

  it("parses a real date", () => {
    expect(parseDateHeader("Thu, 9 May 2026 09:30:00 +0000", 0)).toBe(
      Date.parse("Thu, 9 May 2026 09:30:00 +0000"),
    );
  });
});

describe("toEmail — sender", () => {
  it("takes the address from a display-name form and keeps the name", () => {
    const email = toEmail(message())!;
    expect(email.sender).toBe("ada@example.com");
    expect(email.name).toBe("Ada Lovelace");
  });

  it("strips a display name that carries a bidi override", () => {
    // A name that renders as something else than it is is a spoofing trick; the
    // sanitiser runs before anything is shown or classified.
    const hostile = "Ada\u202ELoyevace";
    const email = toEmail(
      message({
        payload: part({
          headers: [{ name: "From", value: `${hostile} <ada@example.com>` }],
        }),
      }),
    )!;
    expect(email.name).not.toContain("\u202E");
    expect(email.sender).toBe("ada@example.com");
  });

  it("keeps an unparseable From as the raw header rather than dropping the row", () => {
    const email = toEmail(
      message({ payload: part({ headers: [{ name: "From", value: "no angle brackets" }] }) }),
    )!;
    expect(email.sender).toBe("no angle brackets");
  });

  it("gives a message with no From at all a placeholder, not an empty sender", () => {
    // `""` is not nullish, so the fallback cannot be `from.trim() ?? ...`; a
    // message with no `From` must get a placeholder.
    const email = toEmail(message({ payload: part({ headers: [] }) }))!;
    expect(email.sender).toBe("unknown@unknown");
  });
});

describe("toEmail — body", () => {
  it("prefers text/plain over text/html when both exist", () => {
    const email = toEmail(
      message({
        payload: {
          mimeType: "multipart/alternative",
          parts: [
            part({ mimeType: "text/plain", body: { data: b64("plain wins"), size: 10 } }),
            part({ mimeType: "text/html", body: { data: b64("<p>html loses</p>"), size: 18 } }),
          ],
        },
      }),
    )!;
    expect(email.body).toBe("plain wins");
  });

  it("keeps the HTML alongside for the original-message path", () => {
    const email = toEmail(
      message({
        payload: {
          mimeType: "multipart/alternative",
          parts: [
            part({ body: { data: b64("plain"), size: 5 } }),
            part({ mimeType: "text/html", body: { data: b64("<b>rich</b>"), size: 12 } }),
          ],
        },
      }),
    )!;
    expect(email.bodyHtml).toBe("<b>rich</b>");
  });

  it("falls back to the snippet when the payload carries no text", () => {
    const email = toEmail(
      message({ payload: part({ mimeType: "application/pdf", body: { attachmentId: "a1" } }) }),
    )!;
    expect(email.body).toBe("a snippet");
  });

  it("drops a draft stub that has no body at all", () => {
    // The stub would otherwise appear as an empty row the user cannot act on.
    expect(
      toEmail({ id: "m1", labelIds: [LABEL.draft], snippet: "" }),
    ).toBeNull();
    expect(toEmail({ id: "m1", labelIds: [LABEL.sent] })).toBeNull();
  });

  it("keeps a draft that has a body", () => {
    // Discarding every draft would silently destroy work in progress.
    const email = toEmail({
      id: "m1",
      labelIds: [LABEL.draft],
      internalDate: "1770000000000",
      payload: part({ headers: [{ name: "From", value: "ada@example.com" }] }),
    })!;
    expect(email.body).toBe("hello");
  });
});

describe("messageIdHeader", () => {
  it("accepts a well-formed id and trims the header's whitespace", () => {
    expect(messageIdHeader(" <CAM7v@mail.gmail.com> ")).toBe("<CAM7v@mail.gmail.com>");
  });

  it("refuses a value carrying a line break", () => {
    // Ends up inside a header of a message Winnow sends; a `Message-ID` with a
    // CRLF would let the sender append headers to the reply.
    expect(messageIdHeader("<a@b>\r\nBcc: someone@else.com")).toBeUndefined();
    expect(messageIdHeader("<a@b>\nX-Evil: yes")).toBeUndefined();
  });

  it("refuses something that is not a Message-ID at all", () => {
    expect(messageIdHeader("CAM7v")).toBeUndefined();
    expect(messageIdHeader("<no-domain>")).toBeUndefined();
    expect(messageIdHeader("<two@at@signs>")).toBeUndefined();
    expect(messageIdHeader("")).toBeUndefined();
    expect(messageIdHeader(undefined)).toBeUndefined();
  });
});

describe("toEmail — the rest", () => {
  it("carries the Message-ID through, so a reply can thread on it", () => {
    // Gmail threads a reply on its own thread id; the recipient's client threads
    // it on this. Carrying it is the only way the second works.
    const email = toEmail(
      message({
        payload: part({
          headers: [
            { name: "From", value: "ada@example.com" },
            { name: "Message-ID", value: "<CAM7v@mail.gmail.com>" },
          ],
        }),
      }),
    )!;
    expect(email.messageId).toBe("<CAM7v@mail.gmail.com>");
  });

  it("trusts internalDate over the Date: header", () => {
    // A sender can put anything in `Date:`; `internalDate` is when Gmail received it.
    const email = toEmail(
      message({
        internalDate: "1770000000000",
        payload: part({
          headers: [
            { name: "From", value: "ada@example.com" },
            { name: "Date", value: "Thu, 1 Jan 1970 00:00:00 +0000" },
          ],
        }),
      }),
    )!;
    expect(email.receivedAt).toBe(1770000000000);
  });

  it("falls back to the Date: header when internalDate is missing", () => {
    const stamp = "Thu, 9 May 2026 09:30:00 +0000";
    const email = toEmail(
      message({
        internalDate: undefined,
        payload: part({
          headers: [
            { name: "From", value: "ada@example.com" },
            { name: "Date", value: stamp },
          ],
        }),
      }),
    )!;
    expect(email.receivedAt).toBe(Date.parse(stamp));
  });

  it("maps Gmail's category, and degrades an unknown one to primary", () => {
    expect(toEmail(message({ labelIds: [LABEL.inbox, LABEL.receipts] }))!.category).toBe("receipts");
    expect(toEmail(message({ labelIds: [LABEL.inbox, "CATEGORY_SOMETHING_NEW"] }))!.category).toBe(
      "primary",
    );
  });

  it("carries starred and unread as labels, and never as urgent", () => {
    const email = toEmail(message({ labelIds: [LABEL.inbox, LABEL.starred, LABEL.unread] }))!;
    expect(email.starred).toBe(true);
    expect(email.unread).toBe(true);
    expect(email.urgent).toBe(false);
  });

  it("offers real attachments and skips the inline ones", () => {
    const email = toEmail(
      message({
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            part({ partId: "1", body: { data: b64("see attached"), size: 12 } }),
            // A signature logo: an image with a Content-ID and no filename.
            {
              partId: "2",
              mimeType: "image/png",
              body: { attachmentId: "logo", size: 900 },
              headers: [{ name: "Content-ID", value: "<logo>" }],
            },
            // A tracking pixel: an image with no filename either.
            { partId: "3", mimeType: "image/gif", body: { attachmentId: "pixel", size: 43 } },
            // A real file.
            {
              partId: "4",
              mimeType: "application/pdf",
              filename: "lease.pdf",
              body: { attachmentId: "doc", size: 120_000 },
            },
          ],
        },
      }),
    )!;
    expect(email.attachments).toEqual([
      {
        id: "doc",
        partId: "4",
        filename: "lease.pdf",
        mimeType: "application/pdf",
        size: 120_000,
        inline: false,
      },
    ]);
  });

  it("names an attachment that arrived nameless", () => {
    const email = toEmail(
      message({
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            part(),
            { partId: "2", mimeType: "application/octet-stream", body: { attachmentId: "x", size: 1 } },
          ],
        },
      }),
    )!;
    expect(email.attachments[0].filename).toBe("attachment");
    expect(email.attachments[0].mimeType).toBe("application/octet-stream");
  });

  it("homes the message by its labels", () => {
    expect(toEmail(message({ labelIds: [LABEL.spam] }))!.mailbox).toBe("spam");
  });
});

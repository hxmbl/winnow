/**
 * Gmail's message → Winnow's `Email`.
 *
 * The only place the wire format and the product format meet. Four decisions
 * here are worth stating, because each one is a judgement about a sender-
 * controlled input:
 *
 * 1. **`From` is parsed, not trusted.** The address is extracted from
 *    `Display Name <addr@example.com>`; the display name is sanitised of
 *    control characters, because a name containing a zero-width or bidi
 *    override can render as a different name than it is.
 * 2. **Plain text wins.** A `text/plain` leaf is preferred over `text/html`
 *    even when both exist, because the classifier reads text and the reader
 *    quotes text. HTML is kept alongside for the "show original" path.
 * 3. **Attachments are metadata only.** The bytes are fetched on demand; an
 *    inbox that preloaded every PDF would not open.
 * 4. **Internal date wins over the `Date:` header.** Gmail's `internalDate` is
 *    when the message was received; a sender can put anything in `Date:`.
 */

import {
  CATEGORY_MAP,
  type Attachment,
  type Email,
  type EmailCategory,
  type Mailbox,
} from "../model/email";
import { hashId } from "../model/ids";
import { LABEL, base64UrlDecode, type GmailMessage, type GmailPart } from "./dto";
import { parseAddressHeader, plainTextFromHtml } from "../mail/html";

/** Which mailbox a set of labels files the message in. */
export function mailboxFor(labelIds: readonly string[]): Mailbox {
  // Order matters: trash beats spam beats inbox. A message can legitimately
  // carry more than one of these during the moment a filter moves it, and
  // "where can the user get rid of it" is the better question.
  if (labelIds.includes(LABEL.trash)) return "trash";
  if (labelIds.includes(LABEL.spam)) return "spam";
  if (labelIds.includes(LABEL.inbox)) return "inbox";
  return "archive";
}

/** Read a header by name, case-insensitively. */
export function headerValue(part: GmailPart | undefined, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const header of part?.headers ?? []) {
    if (header.name.toLowerCase() === target) return header.value;
  }
  return undefined;
}

/**
 * Walk the MIME tree, calling `visit` for every leaf.
 *
 * Gmail's payload is a tree: `multipart/alternative` containing a `text/plain`
 * and a `text/html`, which itself may contain inline images. Only leaves
 * carry data, so only leaves are interesting.
 */
function forEachLeaf(part: GmailPart | undefined, visit: (leaf: GmailPart) => void): void {
  if (!part) return;
  if (part.parts && part.parts.length > 0) {
    for (const child of part.parts) forEachLeaf(child, visit);
    return;
  }
  visit(part);
}

/** The longest `text/plain` leaf, or `undefined`. */
function plainTextPart(part: GmailPart | undefined): GmailPart | undefined {
  let best: GmailPart | undefined;
  forEachLeaf(part, (leaf) => {
    if (leaf.mimeType !== "text/plain" || leaf.body?.data === undefined) return;
    if (!best || (leaf.body?.size ?? 0) > (best.body?.size ?? 0)) best = leaf;
  });
  return best;
}

/**
 * The first `text/html` leaf, or `undefined`.
 *
 * Exported for `client.messageBodyHtml`, which needs the same leaf without building a
 * whole `Email` from the message around it.
 */
export function htmlPart(part: GmailPart | undefined): GmailPart | undefined {
  let found: GmailPart | undefined;
  forEachLeaf(part, (leaf) => {
    if (!found && leaf.mimeType === "text/html" && leaf.body?.data !== undefined) found = leaf;
  });
  return found;
}

/**
 * Every attachment worth offering, in the order Gmail listed them.
 *
 * Gmail lists an inline image (a signature logo, a tracking pixel) with an
 * `attachmentId` like any other attachment, and a `Content-ID` header when it
 * was meant to be referenced from the HTML body. Those are excluded: they are
 * part of the message's rendering, not something the user attached, and
 * offering them turns a two-file email into a five-item attachment list.
 */
function collectAttachments(part: GmailPart | undefined): Attachment[] {
  const out: Attachment[] = [];

  const walk = (node: GmailPart | undefined): void => {
    if (!node) return;
    if (node.parts && node.parts.length > 0) {
      for (const child of node.parts) walk(child);
      return;
    }

    const attachmentId = node.body?.attachmentId;
    if (!attachmentId) return;

    const hasContentId = (node.headers ?? []).some(
      (header) => header.name.toLowerCase() === "content-id",
    );
    const inline =
      hasContentId || (node.mimeType?.startsWith("image/") === true && (node.filename ?? "") === "");

    if (inline) return;

    out.push({
      id: attachmentId,
      partId: node.partId ?? "",
      filename: node.filename || "attachment",
      mimeType: node.mimeType ?? "application/octet-stream",
      size: node.body?.size ?? 0,
      inline: false,
    });
  };

  walk(part);
  return out;
}

/**
 * Decode Gmail's base64url chunked body encoding.
 *
 * A body that will not decode becomes an empty string rather than an exception:
 * the headers still classify the message and the snippet still previews it, so a
 * bad body is a worse row, not no row.
 */
export function decodeBody(data: string): string {
  const bytes = base64UrlDecode(data);
  return bytes === null ? "" : new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Gmail's snippet, for messages whose payload cannot be decoded. */
function snippetFor(message: GmailMessage): string {
  return message.snippet ?? "";
}

/** Parse the `Date:` header, tolerating the two formats Gmail emits. */
export function parseDateHeader(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The category Gmail assigned, mapped onto Winnow's union.
 *
 * An unrecognised category becomes `primary` rather than being dropped, so a
 * new Gmail label degrades to "ordinary mail" instead of a hole in the union.
 */
function categoryFor(labelIds: readonly string[]): EmailCategory {
  for (const label of labelIds) {
    const mapped = CATEGORY_MAP[label];
    if (mapped) return mapped;
  }
  return "primary";
}

/**
 * Map a Gmail message to an `Email`, or `null` when it is not something Winnow
 * shows.
 *
 * `null` means "drop it", and is returned for a message the user cannot act on:
 * an outbox or draft stub with no body, which would otherwise appear as an
 * empty row in the inbox.
 */
export function toEmail(message: GmailMessage): Email | null {
  const labelIds = message.labelIds ?? [];
  const payload = message.payload;

  // Gmail returns a stub for anything the user has not actually sent or
  // received. It has labels and nothing else.
  const isOutgoingStub =
    (labelIds.includes(LABEL.sent) || labelIds.includes(LABEL.draft)) &&
    payload === undefined;

  const plain = plainTextPart(payload);
  const html = htmlPart(payload);

  let body = "";
  if (plain) body = decodeBody(plain.body!.data!);
  else if (html) body = plainTextFromHtml(decodeBody(html.body!.data!));
  else body = snippetFor(message);

  // A genuinely empty message: no body, no subject, and no payload at all.
  if (body.trim() === "" && !payload && !message.snippet) {
    if (isOutgoingStub || labelIds.includes(LABEL.draft)) return null;
  }

  const from = headerValue(payload, "From") ?? "";
  const parsedFrom = parseAddressHeader(from);
  // An unparseable `From` still yields a row: the address becomes the raw
  // header, which classifies as unknown rather than as spam. A message with *no*
  // `From` at all — rare, but a mailing list or a bounce can manage it — gets the
  // same placeholder rather than the empty string, which would render as a row with
  // no sender and no monogram. `??` cannot do this: `from.trim()` is `""`, and `""`
  // is not nullish, so the fallback below it was dead code.
  const sender = parsedFrom?.address || from.trim() || "unknown@unknown";

  const fallbackDate = Number(message.internalDate) || Date.now();
  const receivedAt = Number.isFinite(Number(message.internalDate))
    ? Number(message.internalDate)
    : parseDateHeader(headerValue(payload, "Date"), fallbackDate);

  const bodyHtml = html ? decodeBody(html.body!.data!) : undefined;

  return {
    id: hashId(message.id),
    gmailId: message.id,
    threadId: message.threadId || undefined,
    messageId: messageIdHeader(headerValue(payload, "Message-ID")),
    sender,
    name: parsedFrom?.name,
    address: parsedFrom?.address,
    mailbox: mailboxFor(labelIds),
    receivedAt,
    subject: decodeMimeWord(headerValue(payload, "Subject") ?? ""),
    body,
    bodyHtml: bodyHtml && bodyHtml !== body ? bodyHtml : undefined,
    category: categoryFor(labelIds),
    starred: labelIds.includes(LABEL.starred),
    unread: labelIds.includes(LABEL.unread),
    attachments: collectAttachments(payload),
    urgent: false,
  };
}

/**
 * The `Message-ID` header, or `undefined` if there is not a usable one.
 *
 * Carried through as-is rather than re-wrapped, because its whole job is to be
 * the id the *other* client already has. Two things are checked: that it is
 * actually a `Message-ID` (`<local@domain>`), and that it contains no line break.
 * The second is a header-injection guard — this value ends up inside a header of
 * a message Winnow sends, and a `Message-ID` carrying CRLF would let the sender
 * append arbitrary headers to the reply.
 */
export function messageIdHeader(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (/[\r\n]/.test(value)) return undefined;
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/.test(value)) return undefined;
  return value;
}

/**
 * Decode RFC 2047 encoded words: `=?UTF-8?B?...?=`.
 *
 * Non-ASCII subjects are the overwhelmingly common case, so a subject that
 * fails here is a subject that looks like garbage in the list — the single most
 * visible mapping bug there would be.
 *
 * Three things this has to get right, and each was wrong first:
 *
 *   - **Both encodings are byte sequences.** Quoted-printable used to go
 *     byte-by-byte through `String.fromCharCode`, which turns the three escaped
 *     bytes of an em dash (`=E2=80=94`) into three Latin-1 characters — so every
 *     accented subject, curly quote and emoji rendered as mojibake.
 *   - **A word that will not decode is left alone**, rather than the subject
 *     being lost with it.
 *   - **Whitespace between two adjacent words is layout, not content** (RFC 2047
 *     §6.2). Long subjects arrive split exactly this way, and keeping the gap
 *     doubled it, dropping it glued words together.
 */
export function decodeMimeWord(value: string): string {
  const word = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;
  const out: string[] = [];
  let at = 0;

  for (let found = word.exec(value); found; found = word.exec(value)) {
    out.push(value.slice(at, found.index), decodeWord(found));
    at = found.index + found[0].length;

    const gap = /^\s+/.exec(value.slice(at));
    if (gap && value.startsWith("=?", at + gap[0].length)) at += gap[0].length;
  }
  out.push(value.slice(at));
  return out.join("");
}

function decodeWord([match, charset, encoding, data]: RegExpExecArray): string {
  try {
    const bytes =
      encoding.toUpperCase() === "B" ? base64UrlDecode(data) : quotedPrintableBytes(data);
    // An undecodable word is left in place rather than replaced with nothing,
    // which would quietly shorten the subject.
    if (bytes === null) return match;
    return new TextDecoder(charset || "utf-8", { fatal: false }).decode(bytes);
  } catch {
    return match;
  }
}

/** `_` is a space and `=XX` is one byte, so the escapes assemble a byte string. */
function quotedPrintableBytes(data: string): Uint8Array {
  const bytes: number[] = [];
  let run = "";
  /** The literal ASCII between two escaped runs, which must keep its position. */
  const flush = (): void => {
    for (const char of run) bytes.push(char.charCodeAt(0));
    run = "";
  };

  for (let i = 0; i < data.length; i += 1) {
    const char = data[i];
    if (char === "_") {
      flush();
      bytes.push(0x20);
    } else if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(data.slice(i + 1, i + 3))) {
      flush();
      bytes.push(Number.parseInt(data.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      run += char;
    }
  }
  flush();
  return new Uint8Array(bytes);
}

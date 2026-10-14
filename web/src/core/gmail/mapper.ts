/**
 * Gmail's message → Winnow's `Email`.
 *
 * The only place the wire format and the product format meet. Four decisions:
 *
 * 1. **`From` is parsed, not trusted.** The display name is sanitised of control
 *    characters (e.g., zero-width or bidi overrides) because they can render as
 *    a different name than it is.
 * 2. **Plain text wins.** A `text/plain` leaf is preferred over `text/html` when
 *    both exist; HTML is kept alongside for the "show original" path.
 * 3. **Attachments are metadata only.** Bytes are fetched on demand.
 * 4. **Internal date wins over the `Date:` header.** Gmail's `internalDate` is
 *    when the message was received; a sender can put anything in `Date:`.
 */

import {
  CATEGORY_MAP,
  type LoadedBody,
  type Attachment,
  type Contact,
  type Email,
  type EmailCategory,
  type Mailbox,
} from "../model/email";
import { hashId } from "../model/ids";
import { LABEL, base64UrlDecode, type GmailMessage, type GmailPart } from "./dto";
import { decodeEntities, parseAddressHeader, parseAddressList, plainTextFromHtml } from "../mail/html";

/** Which mailbox a set of labels files the message in. */
export function mailboxFor(labelIds: readonly string[]): Mailbox {
  // Order matters: trash beats spam beats inbox beats sent; a message can carry more than
  // one of these mid-move, and "where can the user get rid of it" is the
  // better question.
  //
  // Sent sits below inbox rather than beside it, because a message that is both is one
  // you sent *to yourself* and it belongs where the rest of your mail is.
  if (labelIds.includes(LABEL.trash)) return "trash";
  if (labelIds.includes(LABEL.spam)) return "spam";
  if (labelIds.includes(LABEL.inbox)) return "inbox";
  if (labelIds.includes(LABEL.sent)) return "sent";
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
 * Walk the MIME tree, calling `visit` for every leaf. Only leaves carry data.
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
 * Inline images (signature logos, tracking pixels) with a `Content-ID` header
 * are excluded — they're part of rendering, not user attachments.
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
 * the headers still classify the message and the snippet still previews it.
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
 * An unrecognised category becomes `primary` rather than being dropped.
 */
function categoryFor(labelIds: readonly string[]): EmailCategory {
  for (const label of labelIds) {
    const mapped = CATEGORY_MAP[label];
    if (mapped) return mapped;
  }
  return "primary";
}

/**
 * One recipient header, or `undefined` when the message has none.
 *
 * `undefined` and `[]` are different answers and both are kept: a message with no `Cc`
 * header was not copied to anybody, and a message from an older cache has no idea.
 * Callers read all three as "nobody", which is the only thing they can honestly claim
 * about either.
 */
function recipients(payload: GmailPart | undefined, header: string): Contact[] | undefined {
  const raw = headerValue(payload, header);
  if (raw === undefined) return undefined;
  return parseAddressList(raw);
}

/**
 * Map a Gmail message to an `Email`, or `null` when it is not something Winnow
 * shows.
 *
 * `null` means drop it — e.g., an outbox or draft stub with no body.
 */
export function toEmail(
  message: GmailMessage,
  options: { format?: "full" | "metadata" } = {},
): Email | null {
  const labelIds = message.labelIds ?? [];
  const payload = message.payload;
  const metadata = options.format === "metadata";

  // Gmail returns a stub for anything the user has not actually sent or
  // received. It has labels and nothing else.
  const isOutgoingStub =
    (labelIds.includes(LABEL.sent) || labelIds.includes(LABEL.draft)) &&
    payload === undefined;

  const plain = plainTextPart(payload);
  const html = htmlPart(payload);

  let body = "";
  // A metadata response has no leaves to read, so its body is the snippet — which
  // Gmail HTML-escapes (`&#39;`), unlike a decoded part.
  if (metadata) body = decodeEntities(snippetFor(message));
  else if (plain) body = decodeBody(plain.body!.data!);
  else if (html) body = plainTextFromHtml(decodeBody(html.body!.data!));
  else body = snippetFor(message);

  // A genuinely empty message: no body, no subject, and no payload at all.
  if (body.trim() === "" && !payload && !message.snippet) {
    if (isOutgoingStub || labelIds.includes(LABEL.draft)) return null;
  }

  const from = headerValue(payload, "From") ?? "";
  const parsedFrom = parseAddressHeader(from);
  // An unparseable `From` still yields a row: the address becomes the raw
  // header. A message with no `From` at all gets a placeholder rather than an
  // empty sender (`""` is not nullish).
  const sender = parsedFrom?.address || from.trim() || "unknown@unknown";

  const fallbackDate = Number(message.internalDate) || Date.now();
  const receivedAt = Number.isFinite(Number(message.internalDate))
    ? Number(message.internalDate)
    : parseDateHeader(headerValue(payload, "Date"), fallbackDate);

  const bodyHtml = !metadata && html ? decodeBody(html.body!.data!) : undefined;
  const bulk =
    headerValue(payload, "List-Unsubscribe") !== undefined ||
    headerValue(payload, "List-Id") !== undefined;

  return {
    id: hashId(message.id),
    gmailId: message.id,
    threadId: message.threadId || undefined,
    messageId: messageIdHeader(headerValue(payload, "Message-ID")),
    sender,
    name: parsedFrom?.name,
    address: parsedFrom?.address,
    // Recipients, because sent mail is the only place the other side of a
    // conversation is visible and the composer's recipient list is built from it.
    // Absent rather than empty when the headers are not there, which is the
    // normal case for received mail that disclosed nothing.
    to: recipients(payload, "To"),
    cc: recipients(payload, "Cc"),
    bcc: recipients(payload, "Bcc"),
    mailbox: mailboxFor(labelIds),
    receivedAt,
    subject: decodeMimeWord(headerValue(payload, "Subject") ?? ""),
    body,
    bodyHtml: bodyHtml && bodyHtml !== body ? bodyHtml : undefined,
    category: categoryFor(labelIds),
    starred: labelIds.includes(LABEL.starred),
    unread: labelIds.includes(LABEL.unread),
    attachments: metadata ? [] : collectAttachments(payload),
    urgent: false,
    ...(metadata
      ? {
          bodyLoaded: false,
          ...(payload?.mimeType?.toLowerCase() === "multipart/mixed" ? { attachmentHint: true } : {}),
        }
      : {}),
    ...(message.sizeEstimate !== undefined ? { sizeEstimate: message.sizeEstimate } : {}),
    ...(bulk ? { bulk: true } : {}),
  };
}

/**
 * The body half of a `format=full` message — what lazy loading adds to a row that was
 * synced as metadata. Same decoding as `toEmail`, so a loaded body is byte-for-byte
 * what a full sync would have stored.
 */
export function loadedBodyOf(message: GmailMessage): LoadedBody {
  const email = toEmail(message);
  if (!email) return { body: message.snippet ?? "", attachments: [] };
  return { body: email.body, bodyHtml: email.bodyHtml, attachments: email.attachments };
}

/**
 * The `Message-ID` header, or `undefined` if there is not a usable one.
 *
 * Carried through as-is (must be `<local@domain>` with no line breaks) — a CRLF
 * would let a sender append arbitrary headers to a reply.
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
 * Both encodings are byte sequences. A word that won't decode is left alone
 * rather than losing the subject. Whitespace between two adjacent encoded words
 * is layout, not content (RFC 2047 §6.2).
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
    // An undecodable word is left in place rather than replaced with nothing.
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

/**
 * Building an RFC 822 message.
 *
 * Gmail's `messages.send` takes a base64url-encoded raw message, so sending
 * means writing MIME by hand. This is deliberately minimal: text plus
 * attachments, no alternative bodies, no related-part inline images.
 *
 * Two details that are easy to get wrong and produce mail that clients reject:
 *
 *   - **Line endings.** RFC 822 requires CRLF. A raw LF-only message is
 *     accepted by Gmail's API and then renders with a joined-together body in
 *     some clients, which is exactly the kind of bug that only shows up after
 *     sending to a real person.
 *   - **Header encoding.** A non-ASCII subject or display name must be RFC 2047
 *     encoded; a raw UTF-8 header line is invalid and gets mangled in transit.
 */

import type { Attachment, Draft, Email } from "../model/email";
import { mimeTypeForFilename } from "../model/email";
import { displayName } from "../model/email";

/** A file to attach: its bytes and its name. */
export type OutgoingAttachment = {
  filename: string;
  mimeType?: string;
  bytes: Uint8Array;
};

const CRLF = "\r\n";

/**
 * Encode a header value for transport.
 *
 * Only encodes when it has to: a plain ASCII subject is left alone so the raw
 * message stays readable, which matters when debugging a send.
 */
export function encodeHeaderValue(value: string): string {
  if (isAsciiPrintable(value)) return value;
  return `=?UTF-8?B?${base64Utf8(value)}?=`;
}

/**
 * True when every character is printable ASCII.
 *
 * Written as a character-code loop rather than a regex: a regex over a negated
 * printable range is exactly the `no-control-regex` case, and the eslint
 * disable it needs would sit in a security-sensitive file explaining a rule
 * rather than a hazard.
 */
function isAsciiPrintable(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** base64 of a UTF-8 string, as `atob`/`btoa` want it. */
export function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64url, chunk-free — Gmail accepts either, but url-safe avoids `+` and `/`. */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 2047 base64 words, split so no encoded word exceeds 75 characters. */
function encodeMimeHeader(value: string): string {
  if (isAsciiPrintable(value)) return value;
  const encoded = base64Utf8(value);
  const chunks: string[] = [];
  // 75 is the RFC limit for an encoded word including its delimiters; the
  // payload is base64, so 4 base64 chars per 3 bytes.
  const perChunk = 36;
  for (let i = 0; i < encoded.length; i += perChunk) {
    chunks.push(`=?UTF-8?B?${encoded.slice(i, i + perChunk)}?=`);
  }
  return chunks.join(CRLF + " ");
}

/** Collapse every line ending to CRLF. */
function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, CRLF);
}

export type BuildOptions = {
  from: { address: string; name?: string };
  inReplyTo?: string;
  references?: string[];
  attachments?: OutgoingAttachment[];
};

/** The `From` header, formatted the way mail clients expect. */
function fromHeader(from: BuildOptions["from"]): string {
  if (!from.name) return from.address;
  return `${encodeMimeHeader(from.name)} <${from.address}>`;
}

/**
 * Build the raw message for `draft`.
 *
 * The body goes out as `text/plain; charset=utf-8` with `format=flowed`
 * semantics left off: `format=flowed` lets a client rewrap the quoted lines
 * and silently mangle a `>` block, which defeats the point of quoting.
 */
export function buildMime(draft: Draft, options: BuildOptions): string {
  const boundary = `winnow-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const attachments = options.attachments ?? [];

  const headers: string[] = [
    `From: ${fromHeader(options.from)}`,
    `To: ${draft.to.join(", ")}`,
  ];
  if (draft.cc.length > 0) headers.push(`Cc: ${draft.cc.join(", ")}`);
  if (draft.bcc.length > 0) headers.push(`Bcc: ${draft.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeMimeHeader(draft.subject)}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push(`Message-ID: <${boundary}@winnow.app>`);
  if (options.inReplyTo) {
    headers.push(`In-Reply-To: ${options.inReplyTo}`);
    headers.push(`References: ${[...(options.references ?? []), options.inReplyTo].join(" ")}`);
  }
  headers.push("MIME-Version: 1.0");

  if (attachments.length === 0) {
    headers.push(`Content-Type: text/plain; charset=utf-8`);
    headers.push("Content-Transfer-Encoding: base64");
    // The body is base64 so a non-ASCII draft survives every hop intact.
    const encodedBody = base64Utf8(draft.body).replace(/(.{76})/g, "$1" + CRLF);
    return `${headers.join(CRLF)}${CRLF}${CRLF}${encodedBody}`;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts: string[] = [];
  parts.push(
    [
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      "",
      base64Utf8(draft.body).replace(/(.{76})/g, "$1" + CRLF),
    ].join(CRLF),
  );

  for (const attachment of attachments) {
    const filename = encodeMimeHeader(attachment.filename);
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType ?? mimeTypeForFilename(attachment.filename)}; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        base64UrlChunked(attachment.bytes),
      ].join(CRLF),
    );
  }

  parts.push(`--${boundary}--`);

  return `${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}`;
}

/** base64url for the wire, wrapped at 76 characters as the RFC requires. */
function base64UrlChunked(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/(.{76})/g, "$1" + CRLF);
}

/** The header set for a reply, so `References` can accumulate down a thread. */
export function replyReferences(conversation: readonly Email[]): string[] {
  // Oldest first, which is the order the References header is defined to use.
  return conversation
    .filter((email) => email.gmailId)
    .map((email) => `<${email.gmailId}@mail.gmail.com>`);
}

/** A short summary of an attachment, for the reader's list. */
export function describeAttachment(attachment: Attachment): string {
  return `${attachment.filename} · ${formatBytes(attachment.size)}`;
}

/** Human-readable byte count. Binary units, because that is what mail uses. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The address a reply should come from, for the outbox. */
export function senderOf(account: { emailAddress: string }): string {
  return account.emailAddress;
}

/** Display name for the outbox, falling back to the local part. */
export function outboxName(account: { emailAddress: string }): string {
  return account.emailAddress.split("@")[0];
}

/** A `Message-ID` for a message being sent. */
export function messageIdFor(gmailId: string): string {
  return `<${gmailId}@mail.gmail.com>`;
}

export { displayName };
export { toCrlf };

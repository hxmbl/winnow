/**
 * Building an RFC 822 message.
 *
 * Gmail's `messages.send` takes a base64url-encoded raw message; this is
 * deliberately minimal: text plus attachments, no alternative bodies, no
 * related-part inline images. Envelope encoding is in `client.ts`.
 *
 * Key details: RFC 822 requires CRLF (LF-only is accepted by the API but renders
 * badly in some clients). Non-ASCII subjects/display names must be RFC 2047
 * encoded. Threading headers are built from the message's real `Message-ID` — getting
 * them wrong threads the reply in the sender's own account and nowhere else.
 */

import type { Email, Draft } from "../model/email";
import { mimeTypeForFilename } from "../model/email";

/** A file to attach: its bytes and its name. */
export type OutgoingAttachment = {
  filename: string;
  mimeType?: string;
  bytes: Uint8Array;
};

const CRLF = "\r\n";

/**
 * True when every character is printable ASCII.
 *
 * Written as a character-code loop rather than a regex to avoid the need for a
 * `no-control-regex` exception.
 */
function isAsciiPrintable(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** base64 of a UTF-8 string, as `atob`/`btoa` want it. */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * RFC 2047 base64 words, split so no encoded word exceeds 75 characters.
 *
 * Only encodes when it has to: a plain ASCII subject is left alone for
 * readability when debugging a send.
 *
 * Split on *character* boundaries, never inside one: RFC 2047 §5 requires each
 * encoded word to hold whole characters. Cutting the base64 every N characters cut
 * multi-byte UTF-8 sequences in half, and a strict decoder shows each half as `�` —
 * a CJK or emoji subject arrived with holes in it.
 */
function encodeMimeHeader(value: string): string {
  if (isAsciiPrintable(value)) return value;
  // 45 bytes is 60 base64 characters; with `=?UTF-8?B?` and `?=` that is 72, under 75.
  const maxBytes = 45;
  const encoder = new TextEncoder();
  const words: string[] = [];
  let current = "";
  let currentBytes = 0;
  // `for…of` walks code points, so a surrogate pair is never split either.
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (currentBytes + size > maxBytes && current.length > 0) {
      words.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current.length > 0) words.push(current);
  return words.map((word) => `=?UTF-8?B?${base64Utf8(word)}?=`).join(CRLF + " ");
}

/** What to put in a header, and what the reply is answering. */
export type BuildOptions = {
  from: { address: string; name?: string };
  /**
   * The message being replied to, for `In-Reply-To` and the tail of `References`.
   *
   * The whole message rather than a bare id, because the header has to name the
   * id *that client* already holds.
   */
  inReplyTo?: Email;
  /** The rest of the exchange, oldest first. See `replyReferences`. */
  references?: readonly Email[];
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
 * The body goes out as `text/plain; charset=utf-8` with `format=flowed` left
 * off to avoid silently mangling quoted lines.
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
    const parent = messageIdFor(options.inReplyTo);
    headers.push(`In-Reply-To: ${parent}`);
    headers.push(`References: ${[...replyReferences(options.references ?? []), parent].join(" ")}`);
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
        base64Chunked(attachment.bytes),
      ].join(CRLF),
    );
  }

  parts.push(`--${boundary}--`);

  return `${headers.join(CRLF)}${CRLF}${CRLF}${parts.join(CRLF)}`;
}

/**
 * Standard base64, wrapped at 76 characters as the RFC requires.
 *
 * Plain base64, not base64url. This is `Content-Transfer-Encoding: base64` for a
 * part body; the outer API `raw` envelope uses base64url.
 */
function base64Chunked(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/(.{76})/g, "$1" + CRLF);
}

/**
 * A message's RFC 822 id, for `In-Reply-To` and `References`.
 *
 * The real one when the message carried it; otherwise a synthesised
 * `<gmailId@mail.gmail.com>` — better than a bare id, which threads nowhere.
 */
export function messageIdFor(email: Pick<Email, "gmailId" | "messageId">): string {
  return email.messageId ?? `<${email.gmailId}@mail.gmail.com>`;
}

/**
 * The `References` list for a reply: the exchange, oldest first (RFC 5322 §3.6.4).
 */
export function replyReferences(conversation: readonly Email[]): string[] {
  return [...conversation]
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .filter((email) => email.gmailId)
    .map(messageIdFor);
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

/**
 * Building an RFC 822 message.
 *
 * Gmail's `messages.send` takes a base64url-encoded raw message, so sending
 * means writing MIME by hand — and the envelope is encoded by `client.ts`, the
 * one place that touches the wire. This is deliberately minimal: text plus
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
 *
 * A third only shows up on the *other* side of a reply: the threading headers.
 * They are built from the message's real `Message-ID`, and getting them wrong
 * threads the reply in the sender's own account and nowhere else.
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
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * RFC 2047 base64 words, split so no encoded word exceeds 75 characters.
 *
 * Only encodes when it has to: a plain ASCII subject is left alone, so the raw
 * message stays readable, which matters when debugging a send.
 */
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

/** What to put in a header, and what the reply is answering. */
export type BuildOptions = {
  from: { address: string; name?: string };
  /**
   * The message being replied to, for `In-Reply-To` and the tail of `References`.
   *
   * The whole message rather than a bare id, because the header has to name the
   * id *that client* already holds. `buildMime` used to write whatever string it
   * was handed straight into `In-Reply-To`, so a reply went out as
   * `In-Reply-To: 18c1f3a2…` — not a Message-ID at all — with a well-formed
   * `References` list that then ended in that same malformed entry. Gmail still
   * threaded it, because Gmail matches on its own thread id, so the reply looked
   * fine in the sender's own account and arrived as a new conversation everywhere
   * else.
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
 * Plain base64, *not* the base64url the API's outer `raw` envelope uses: this is a
 * `Content-Transfer-Encoding: base64` body, which every receiving client decodes with
 * the RFC 2045 alphabet, and `-`/`_` are not in it. Written url-safe, an attachment
 * downloads and then will not open — in someone else's client, which is the only place
 * you would find out.
 */
function base64Chunked(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/(.{76})/g, "$1" + CRLF);
}

/**
 * A message's RFC 822 id, for `In-Reply-To` and `References`.
 *
 * The real one when the message carried it, and a synthesised `<gmailId@…>`
 * otherwise — which is what every message cached by an older build, and every
 * message in the demo, has. The synthetic form is not Gmail's, so a reply to one
 * of those threads in Gmail and not elsewhere; it is still better than a bare id,
 * which threads in neither.
 */
export function messageIdFor(email: Pick<Email, "gmailId" | "messageId">): string {
  return email.messageId ?? `<${email.gmailId}@mail.gmail.com>`;
}

/**
 * The `References` list for a reply: the exchange, oldest first.
 *
 * The order is defined by RFC 5322 §3.6.4 and a client that walks it out of
 * order will treat the reply as belonging to whichever message it saw last.
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

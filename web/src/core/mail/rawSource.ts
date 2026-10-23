/**
 * Dev Options → View Original: a message's raw RFC 5322 source, and an outline of its
 * MIME tree, as text.
 *
 * The source comes from Gmail's `format=raw` (`GmailClient.messageRaw`). Nothing here
 * renders it: the result is shown in a `<pre>` as a text node, so a `<script>` in a part
 * is the eleven characters it is and nothing more. Parts are only outlined (type,
 * charset, transfer encoding, file name, size), never decoded.
 */

import type { Email } from "../model/email";

/** At most this much of the source is put on screen; Copy always copies all of it. */
export const RAW_DISPLAY_LIMIT = 2_000_000;

type Headers = Array<{ name: string; value: string }>;

/** Header block and body, split at the first empty line. */
function splitEntity(text: string): { headers: Headers; body: string } {
  const match = /\r?\n\r?\n/.exec(text);
  const head = match ? text.slice(0, match.index) : text;
  const body = match ? text.slice(match.index + match[0].length) : "";
  const headers: Headers = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length > 0) {
      headers[headers.length - 1]!.value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return { headers, body };
}

function header(headers: Headers, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** A parameter of a structured header (`boundary`, `charset`, `filename`, `name`). */
function param(value: string | undefined, key: string): string | undefined {
  if (!value) return undefined;
  const match = new RegExp(`(?:^|;)\\s*${key}\\*?=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i").exec(value);
  return match ? (match[1] ?? match[2]) : undefined;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** One line per MIME entity, indented by depth. */
function outline(text: string, depth: number, out: string[], path: string): void {
  const { headers, body } = splitEntity(text);
  const contentType = header(headers, "Content-Type") ?? "text/plain";
  const type = contentType.split(";")[0]!.trim().toLowerCase() || "text/plain";
  const bits = [type];
  const charset = param(contentType, "charset");
  if (charset) bits.push(`charset=${charset}`);
  const encoding = header(headers, "Content-Transfer-Encoding");
  if (encoding) bits.push(encoding.toLowerCase());
  const disposition = header(headers, "Content-Disposition");
  if (disposition) bits.push(disposition.split(";")[0]!.trim().toLowerCase());
  const filename = param(disposition, "filename") ?? param(contentType, "name");
  if (filename) bits.push(`"${filename}"`);
  const contentId = header(headers, "Content-ID");
  if (contentId) bits.push(`cid ${contentId}`);

  const boundary = type.startsWith("multipart/") ? param(contentType, "boundary") : undefined;
  if (!boundary || depth > 20) {
    bits.push(size(byteLength(body)));
    out.push(`${"  ".repeat(depth)}${path} ${bits.join(" · ")}`);
    return;
  }
  out.push(`${"  ".repeat(depth)}${path} ${bits.join(" · ")}`);
  const delimiter = `--${boundary}`;
  const sections = body.split(new RegExp(`(?:^|\\r?\\n)${escapeRegExp(delimiter)}`));
  // [0] is the preamble; a section starting with "--" is the close delimiter's epilogue.
  let index = 0;
  for (const section of sections.slice(1)) {
    if (section.startsWith("--")) break;
    index += 1;
    outline(section.replace(/^[ \t]*\r?\n/, ""), depth + 1, out, `${path}.${index}`);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The MIME tree of a raw message, one entity per line ("1", "1.1", "1.2" …). */
export function mimeOutline(raw: string): string[] {
  const out: string[] = [];
  outline(raw, 0, out, "1");
  return out;
}

/** What View Original puts on screen: the outline, then the whole source as sent. */
export function rawSourceText(raw: string): { text: string; truncated: boolean } {
  const truncated = raw.length > RAW_DISPLAY_LIMIT;
  const source = truncated ? raw.slice(0, RAW_DISPLAY_LIMIT) : raw;
  const text = [
    "MIME structure",
    ...mimeOutline(raw),
    "",
    "Raw source (every header and every part, as sent)",
    "",
    source,
    ...(truncated ? ["", `… ${size(raw.length - RAW_DISPLAY_LIMIT)} more not shown; Copy copies all of it.`] : []),
  ].join("\n");
  return { text, truncated };
}

/** Gmail's `raw`: base64url of the message's bytes. Decoded as UTF-8, tolerantly. */
export function decodeRawMessage(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return "";
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * The demo has no server, so its "original" is built here from the demo message: real
 * headers and a real `multipart/alternative` tree, marked as built on this device.
 */
export function demoRawSource(email: Pick<Email, "sender" | "name" | "subject" | "receivedAt" | "gmailId" | "body" | "bodyHtml">): string {
  const boundary = `winnow-demo-${email.gmailId}`;
  const from = email.name ? `"${email.name}" <${email.sender}>` : email.sender;
  const head = [
    `From: ${from}`,
    "To: you@example.com",
    `Subject: ${email.subject}`,
    `Date: ${new Date(email.receivedAt).toUTCString()}`,
    `Message-ID: <${email.gmailId}@demo.winnow.invalid>`,
    "X-Winnow-Demo: built on this device; the demo has no server to ask for the original",
    "MIME-Version: 1.0",
  ];
  if (!email.bodyHtml) {
    return [...head, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", email.body].join("\r\n");
  }
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    email.body,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    email.bodyHtml,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

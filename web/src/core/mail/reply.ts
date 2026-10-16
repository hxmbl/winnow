/**
 * Building a reply.
 *
 * Quoting (attribution, `>` prefixing, HTML-to-text fallback) is here, ported from
 * the Swift implementation. An empty line becomes a bare `>` with no trailing
 * space — a trailing space survives into the sent message as a stray blank line.
 *
 * A quote is stripped only while it is still an untouched *suffix* of the body, so
 * edits above it are never deleted. Ported from
 * `legacy/swift-native/Sources/winnow/Support/ReplyQuoting.swift`.
 */

import type { Email, Draft } from "../model/email";
import { displayName } from "../model/email";
import { formatListTime } from "./datetime";
import { plainTextFromHtml } from "./html";

/** Prefixes every line of the original message with `> `. */
export function quotedBody(source: string): string {
  // An empty body quotes to nothing, not to a lone `>`.
  if (source.length === 0) return "";
  return source
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * The attribution line above a quote, using the list-row formatter so it reads
 * like the header of the message it quotes.
 */
export function attributionLine(email: Email): string {
  return `On ${formatListTime(email.receivedAt)}, ${displayName(email)} wrote:`;
}

/**
 * The full quote block: attribution, then the original message, falling back to
 * stripped HTML when there is no plain text.
 */
export function quoteBlockFor(email: Email): string {
  const source = email.body.trim().length > 0 ? email.body : plainTextFromHtml(email.bodyHtml ?? "");
  const attribution = attributionLine(email);
  const quoted = quotedBody(source);
  return quoted.length > 0 ? `${attribution}\n${quoted}` : attribution;
}

/**
 * Whether `text` still ends with `block`, unmodified. Both must be non-empty: an
 * empty block would match every string as a suffix.
 */
export function isIntactSuffix(text: string, block: string | undefined): boolean {
  if (!block || block.length === 0) return false;
  return text.endsWith(block);
}

/** Strip a still-untouched quote from the end of a draft body. */
export function stripQuote(body: string, block: string | undefined): string {
  if (!isIntactSuffix(body, block)) return body;
  // `block` is non-empty here: `isIntactSuffix` returns false for anything else.
  return body.slice(0, body.length - (block as string).length);
}

/**
 * `Re: ` the subject, without doubling it. The check is lowercased because mail
 * clients disagree about case — `RE:`, `Re:`, `re:` all mean the same thing.
 */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed.toLowerCase().startsWith("re:")) return trimmed;
  return `Re: ${trimmed}`;
}

export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed.toLowerCase().startsWith("fwd:")) return trimmed;
  return `Fwd: ${trimmed}`;
}

/**
 * A reply draft, pre-filled with the quote. `replyAll` takes addresses from the
 * thread rather than from one message.
 */
export function buildReply(
  original: Email,
  conversation: readonly Email[],
  options: { replyAll?: boolean; selfAddress?: string } = {},
): Draft {
  const { replyAll = false, selfAddress } = options;
  const quote = quoteBlockFor(original);
  const latest = conversation[conversation.length - 1] ?? original;

  const to = new Set<string>();
  if (replyAll) {
    for (const message of conversation) {
      if (message.sender && message.sender !== selfAddress) to.add(message.sender);
    }
  }
  if (to.size === 0) to.add(latest.sender);

  return {
    to: [...to],
    cc: [],
    bcc: [],
    subject: replySubject(latest.subject),
    // No leading blank line, so the quote block stays a true suffix of `body`.
    body: quote,
    inReplyTo: latest.gmailId,
    threadId: latest.threadId,
    quoteBlock: quote,
    // A reply's body is entirely the quote; anything above it is the user's.
    prefilled: "",
  };
}

/** A forward draft: no quote markers, just the message with a header. */
export function buildForward(
  original: Email,
  conversation: readonly Email[],
  to: string[],
): Draft {
  const latest = conversation[conversation.length - 1] ?? original;
  const body = conversation
    .map((message) => {
      const source = message.body.trim().length > 0 ? message.body : plainTextFromHtml(message.bodyHtml ?? "");
      return `${attributionLine(message)}\n${source}`;
    })
    .join("\n\n");

  return {
    to,
    cc: [],
    bcc: [],
    subject: forwardSubject(latest.subject),
    body,
    threadId: latest.threadId,
    // Unlike a reply, a forward's prefilled text is *meant to stay*.
    prefilled: body,
  };
}

/**
 * Switch a reply between Reply and Reply all, keeping everything the user wrote.
 *
 * Only `to` changes, and it is recomputed by `buildReply` itself so the toggle and a fresh
 * reply can never disagree about who is on it — including the exclusion of the user's own
 * address, which `buildReply`'s tests pin.
 */
export function withReplyAll(
  draft: Draft,
  original: Email,
  conversation: readonly Email[],
  replyAll: boolean,
  selfAddress?: string,
): Draft {
  const { to } = buildReply(original, conversation, { replyAll, selfAddress });
  return { ...draft, to };
}

/**
 * Building a reply.
 *
 * Two jobs, and the second is the interesting one.
 *
 * **Quoting.** The attribution line, the `>` prefixing, and the HTML-to-text
 * fallback are all here, ported verbatim from the Swift implementation. The
 * prefixing rule that matters: an empty line becomes a bare `>` with *no*
 * trailing space, because a trailing space survives into the sent message and
 * shows up as a stray blank line in every mail client the recipient uses.
 *
 * **Removing the quote.** When a user replies, edits the top of the quoted
 * text, and sends, the quote must stay — that is their message now. So the
 * block is only ever stripped when it is still an untouched *suffix* of the
 * body. A `startsWith` check would silently delete a user's edits.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Support/ReplyQuoting.swift`.
 */

import type { Email, Draft } from "../model/email";
import { displayName } from "../model/email";
import { formatListTime } from "./datetime";
import { plainTextFromHtml } from "./html";

/** Prefixes every line of the original message with `> `. */
export function quotedBody(source: string): string {
  // An empty body quotes to nothing, not to a lone `>`. A body that arrives
  // empty (an image-only message, or a failed HTML decode) would otherwise
  // produce a reply that opens with a bare quote marker and nothing under it.
  if (source.length === 0) return "";
  return source
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * The attribution line above a quote.
 *
 * Reuses the list-row formatter so the attribution reads like the header of
 * the message it is quoting — using a different format here was a small
 * inconsistency that read as a bug.
 */
export function attributionLine(email: Email): string {
  return `On ${formatListTime(email.receivedAt)}, ${displayName(email)} wrote:`;
}

/**
 * The full quote block: attribution, then the original message.
 *
 * Falls back to stripping the HTML when there is no plain text, which happens
 * for mail sent from a webmail client that only emits `text/html`.
 */
export function quoteBlockFor(email: Email): string {
  const source = email.body.trim().length > 0 ? email.body : plainTextFromHtml(email.bodyHtml ?? "");
  const attribution = attributionLine(email);
  const quoted = quotedBody(source);
  return quoted.length > 0 ? `${attribution}\n${quoted}` : attribution;
}

/**
 * Whether `text` still ends with `block`, unmodified.
 *
 * Both the block and the text must be non-empty: an empty block would match
 * every string as a suffix, and a user who cleared the composer should not have
 * that read as "the quote is intact".
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
 * `Re: ` the subject, without doubling it.
 *
 * The check is on the lowercased subject because mail clients disagree about
 * case — `RE:`, `Re:`, `re:` all mean the same thing, and treating `RE:` as
 * unprefixed produced `Re: RE: Re: …` over a long thread.
 */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed.toLowerCase().startsWith("re:")) return trimmed;
  return `Re: ${trimmed}`;
}

/** Strip a leading quote block and blank lines, for a clean forward. */
export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed.toLowerCase().startsWith("fwd:")) return trimmed;
  return `Fwd: ${trimmed}`;
}

/**
 * A reply draft, pre-filled with the quote.
 *
 * `replyAll` takes the addresses from the thread rather than from one message,
 * because the person who needs to answer is usually the one who wrote last.
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
    // The quote starts the body, with no leading blank line, so that
    // `quoteBlock` is a true suffix of `body` and the user's first keystroke
    // lands above it. A leading `\n` here would leave the block stranded by a
    // newline that is not part of it, and stripping the quote would then leave
    // that newline behind.
    body: quote,
    inReplyTo: latest.gmailId,
    threadId: latest.threadId,
    quoteBlock: quote,
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
  };
}

/** A blank compose, for a message with no thread to reply to. */
export function buildCompose(to: string[] = []): Draft {
  return { to, cc: [], bcc: [], subject: "", body: "" };
}

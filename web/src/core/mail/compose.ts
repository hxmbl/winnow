/**
 * Composing a new message: the blank draft, what makes one sendable, and `mailto:`.
 *
 * A new message is a `Draft` like a reply's, minus everything that ties it to a
 * conversation: no `inReplyTo`, no `threadId`, no quote. It goes out through the same
 * `buildMime` as a reply, so the subject's RFC 2047 encoding and the body's base64 are
 * one implementation, not two that can disagree.
 */

import type { Draft } from "../model/email";
import { isValidAddress, parseRecipients } from "../contacts/addresses";

/** What a new draft may start with — a `mailto:` link, or nothing at all. */
export type NewDraftInit = Partial<Pick<Draft, "to" | "cc" | "bcc" | "subject" | "body">>;

/**
 * A blank draft for a new message.
 *
 * `prefilled` is the body it starts with, so the discard question is asked only about
 * what the user wrote — a `mailto:` body is the link's text, not theirs. Recipients and
 * the subject count as written (see `isUntouchedNewDraft`), so a draft opened from a
 * link with an address in it is still something to ask about only once it is edited.
 */
export function buildNewDraft(init: NewDraftInit = {}): Draft {
  const body = init.body ?? "";
  return {
    to: normaliseRecipients(init.to ?? []),
    cc: normaliseRecipients(init.cc ?? []),
    bcc: normaliseRecipients(init.bcc ?? []),
    subject: init.subject ?? "",
    body,
    prefilled: body,
  };
}

/**
 * Every entry as the draft carries it: a bare address where the text is one, and the
 * text itself where it is not (so it shows as an invalid chip rather than vanishing).
 * Accepts `Name <a@b>` and comma/semicolon lists inside one entry. Duplicates, compared
 * case-insensitively, are dropped.
 */
export function normaliseRecipients(entries: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const token of parseRecipients(entry)) {
      const key = token.value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(token.value);
    }
  }
  return out;
}

/** Why a draft cannot be sent yet, or `null` when it can. */
export type RecipientProblem = "none" | "invalid";

/**
 * The recipients check the Send button and ⌘⏎ share: at least one address across
 * To, Cc and Bcc, and nothing that is not an address. Bcc alone is a valid message —
 * Gmail sends it with an empty To.
 */
export function recipientProblem(draft: Pick<Draft, "to" | "cc" | "bcc">): RecipientProblem | null {
  const all = [...draft.to, ...draft.cc, ...draft.bcc];
  if (all.length === 0) return "none";
  if (!all.every((address) => isValidAddress(address))) return "invalid";
  return null;
}

/** True when the subject is blank, which earns a "send without a subject?" question. */
export function needsSubjectConfirmation(draft: Pick<Draft, "subject">): boolean {
  return draft.subject.trim().length === 0;
}

/**
 * Whether closing this new draft would lose anything: an untouched one closes
 * without a question. Anything in a recipient field, the subject, or a body that
 * differs from what it opened with is the user's.
 */
export function isUntouchedNewDraft(draft: Draft, initial: Pick<Draft, "to" | "cc" | "bcc" | "subject">): boolean {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  // A file attached is something written.
  if ((draft.attachments?.length ?? 0) > 0) return false;
  return (
    same(draft.to, initial.to) &&
    same(draft.cc, initial.cc) &&
    same(draft.bcc, initial.bcc) &&
    draft.subject.trim() === initial.subject.trim() &&
    draft.body.trim() === (draft.prefilled ?? "").trim()
  );
}

/**
 * A draft from a `mailto:` URL (RFC 6068): the path's addresses, then `to`, `cc`,
 * `bcc`, `subject` and `body` from the query. Other header fields are ignored —
 * a link may not set `From`, `In-Reply-To` or anything else that would make the
 * message something other than what the user is looking at. `null` for anything
 * that is not a `mailto:` URL.
 */
export function draftFromMailto(url: string): Draft | null {
  const trimmed = url.trim();
  if (!/^mailto:/i.test(trimmed)) return null;
  const rest = trimmed.slice("mailto:".length);
  const queryAt = rest.indexOf("?");
  const path = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
  const query = queryAt >= 0 ? rest.slice(queryAt + 1) : "";

  const to: string[] = [];
  const cc: string[] = [];
  const bcc: string[] = [];
  let subject = "";
  let body = "";
  const pathText = safeDecode(path);
  if (pathText) to.push(pathText);

  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = safeDecode(eq >= 0 ? pair.slice(0, eq) : pair).toLowerCase();
    const value = safeDecode(eq >= 0 ? pair.slice(eq + 1) : "");
    switch (name) {
      case "to":
        to.push(value);
        break;
      case "cc":
        cc.push(value);
        break;
      case "bcc":
        bcc.push(value);
        break;
      case "subject":
        subject = value;
        break;
      case "body":
        // RFC 6068 line breaks are %0D%0A; the composer is a textarea, which wants \n.
        body = value.replace(/\r\n?/g, "\n");
        break;
      default:
    }
  }

  return buildNewDraft({ to, cc, bcc, subject, body });
}

/** `decodeURIComponent` that leaves a malformed escape as written instead of throwing. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

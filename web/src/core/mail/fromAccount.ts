/**
 * Which account a message goes out from (1.4.0), and what a reply needs when it goes
 * out from an account other than the one that received the original.
 *
 * Pure. The composer's From picker lists the signed-in accounts; this decides where it
 * starts and how a cross-account reply is sent.
 */

import type { Draft, Email } from "../model/email";

/**
 * Where the picker starts: a reply or forward on the account that received the message
 * (which is the open one: a message is only ever read in its own account), a new message
 * on the open account.
 */
export function defaultFromAccount(options: {
  mode: "reply" | "forward" | "new";
  /** The account the original arrived in, for a reply or forward. */
  receivedIn: string | null;
  open: string | null;
}): string | null {
  if (options.mode !== "new" && options.receivedIn) return options.receivedIn;
  return options.open;
}

/**
 * A reply sent from another account. Gmail thread ids belong to one mailbox, and the
 * other account's cache does not have the original, so the message goes as a new one
 * carrying the original's `In-Reply-To` and `References` (`Draft.replyHeaders`, the path
 * a reopened draft whose original is gone already takes): it still threads for the
 * recipients, and in the sending account's own Sent.
 */
export function draftFromAnotherAccount(draft: Draft, original: Pick<Email, "messageId"> | undefined): Draft {
  const next: Draft = { ...draft };
  delete next.inReplyTo;
  delete next.threadId;
  const id = original?.messageId?.trim();
  if (id) next.replyHeaders = { inReplyTo: id, references: draft.replyHeaders?.references ?? id };
  return next;
}

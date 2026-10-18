/**
 * Browsing a user label as a mailbox: which messages it lists.
 *
 * Gmail's label view is every message carrying the label wherever it is filed, except
 * the Trash and Spam (which Gmail keeps out of every label view) and Drafts (listed
 * through the drafts API, never in `all`). The store's `labelView` is the label id;
 * `mailbox` stays what it was, so leaving the label returns to the same place.
 */

import type { Email } from "../model/email";

/** Whether `email` is listed when browsing `labelId`. */
export function inLabelView(email: Pick<Email, "labels" | "mailbox">, labelId: string): boolean {
  if (email.mailbox === "trash" || email.mailbox === "spam" || email.mailbox === "drafts") return false;
  return email.labels?.includes(labelId) ?? false;
}

/**
 * The messages a label change touches: the targets and every other message on their
 * conversations, because Gmail labels a conversation (`threads.modify`), not a message.
 */
export function labelTargets(all: readonly Email[], ids: readonly number[]): Set<number> {
  const wanted = new Set(ids);
  const threads = new Set<string>();
  for (const email of all) if (wanted.has(email.id) && email.threadId) threads.add(email.threadId);
  const targets = new Set<number>();
  for (const email of all) {
    if (wanted.has(email.id) || (email.threadId !== undefined && threads.has(email.threadId))) targets.add(email.id);
  }
  return targets;
}

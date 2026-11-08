/**
 * Thread and cursor lookups.
 *
 * Pure functions over the derived view: they answer "which row is this message on"
 * without touching store state.
 */

import type { Email } from "../../model/email";
import { threadKey } from "../../model/ids";
import type { ThreadRow } from "../../classify/pipeline";
import type { MailboxView, StoreState } from "../state";
import { NO_CURSOR } from "../state";

/** A message's conversation key, the same one `groupThreads` files it under. */
export function threadKeyOf(email: Email): string {
  return threadKey(email);
}

/**
 * The row in `threads` that shows message `id`, or `-1`.
 *
 * The row whose representative it is first, and otherwise the row of its conversation —
 * but only for a message of the mailbox on screen (`mailboxEmails`): a thread's sent
 * reply shares the inbox row's key, and is not read *on* that row.
 */
export function rowIndexOf(
  threads: readonly ThreadRow[],
  id: number | null,
  mailboxEmails: readonly Email[],
): number {
  if (id === null) return -1;
  const direct = threads.findIndex((row) => row.representative.id === id);
  if (direct >= 0) return direct;
  const email = mailboxEmails.find((candidate) => candidate.id === id);
  if (!email) return -1;
  const key = threadKeyOf(email);
  return threads.findIndex((row) => row.key === key);
}

/**
 * The 0-based row the position readout ("4 of 39") names, or `NO_CURSOR` for none.
 *
 * With a message open it is that message's row and nothing else — never the cursor,
 * which is a separate piece of state and has drifted from the reader before (a sync, an
 * archive above, an undo, a filter, a re-sort). An open message that is not a visible
 * row gets no number at all: the neutral readout is honest, a neighbour's number is not.
 * With nothing open it is the cursor, if that is on a row.
 */
export function readoutIndex(
  state: Pick<StoreState, "selectedId" | "cursorIndex">,
  view: Pick<MailboxView, "threads" | "selectedIndex">,
): number {
  if (state.selectedId !== null) return view.selectedIndex >= 0 ? view.selectedIndex : NO_CURSOR;
  return state.cursorIndex >= 0 && state.cursorIndex < view.threads.length ? state.cursorIndex : NO_CURSOR;
}

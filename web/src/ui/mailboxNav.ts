/**
 * The order navigation lists the mailboxes in.
 *
 * Presentation, not model: which folder a message is in is a fact about mail, but
 * which row sits above another is a fact about this screen. Keeping it here is what
 * lets the store and the persistence layer validate a restored mailbox against the
 * model's vocabulary (`isMailboxOrView`) instead of against the sidebar's order — a
 * new row can move without changing which stored values are still readable.
 */

import type { Mailbox } from "../core/model/email";

/**
 * The desktop sidebar's rows, top to bottom. Snoozed and Scheduled are views (1.4.0);
 * the phone panel shows these upside down (`PANEL_ORDER` in `ui/phoneDock.ts`).
 */
export const MAILBOX_ORDER = [
  "inbox",
  "snoozed",
  "archive",
  "sent",
  "scheduled",
  "drafts",
  "trash",
  "spam",
] as const satisfies readonly Mailbox[];

/**
 * The reader's action bar, as data: which verbs, in which order, what each is called in
 * this mailbox, and the key that does the same thing. `Reader.tsx` draws it; this decides
 * it, so the rules are unit-tested rather than trapped in JSX.
 *
 * The order is the design. The bar sits at the top-left of the reader, the side the
 * cursor arrives from (the list is to its left), and in one place for every message, so
 * the hand learns it:
 *
 *   Reply all · Forward │ Archive · Snooze · Delete │ Mark unread · Star   ⋯ More
 *
 * Reply all leads and is the one filled button: answering is what a read ends in most
 * often after triage, and it is the verb Gmail hides behind a scroll to the bottom.
 * Archive and Delete come next, together, because they are the two ways a message
 * leaves. Read state and star are toggles, icon-only, at the end of the group.
 */

import { shortcutFor, type Command } from "../core/mail/keybinds";
import type { Mailbox } from "../core/model/email";

export type ReaderActionId = "reply" | "forward" | "archive" | "snooze" | "notSpam" | "trash" | "read" | "star";

export type ReaderAction = {
  id: ReaderActionId;
  /** The full name: the accessible name and the tooltip's words. */
  label: string;
  /** What the button shows when the pane is wide enough for words (`null`: icon only). */
  text: string | null;
  /** The key, as the shortcut sheet prints it, or `null`. */
  keys: string | null;
  /** Which cluster it is in; a divider separates clusters. */
  group: "respond" | "leave" | "toggle";
  /** The one filled button. */
  primary?: boolean;
  /** For toggles: whether it is on (starred, unread). */
  pressed?: boolean;
};

const keysFor = (command: Command["type"]): string | null => shortcutFor(command);

/** The bar for a message in `mailbox`, given its star and read state. */
export function readerActions(mailbox: Mailbox, state: { starred: boolean; unread: boolean }): ReaderAction[] {
  const actions: ReaderAction[] = [
    { id: "reply", label: "Reply to all", text: "Reply all", keys: keysFor("focusReply"), group: "respond", primary: true },
    { id: "forward", label: "Forward", text: "Forward", keys: keysFor("forward"), group: "respond" },
  ];
  // In Spam the way out is "not spam" (it moves to the Inbox); elsewhere it is Archive,
  // or its reverse where the message is already out of the Inbox.
  if (mailbox === "spam") {
    actions.push({ id: "notSpam", label: "Not spam — move to inbox", text: "Not spam", keys: null, group: "leave" });
  } else if (mailbox === "snoozed") {
    actions.push({ id: "archive", label: "Unsnooze — back to the inbox now", text: "Unsnooze", keys: keysFor("archive"), group: "leave" });
  } else {
    const label = mailbox === "inbox" ? "Archive" : mailbox === "archive" ? "Move to inbox" : "Restore";
    const text = mailbox === "inbox" ? "Archive" : mailbox === "archive" ? "Inbox" : "Restore";
    actions.push({ id: "archive", label, text, keys: keysFor("archive"), group: "leave" });
  }
  // Snooze (1.4.0): mail in the Inbox or the Archive, and a new time for snoozed mail.
  if (mailbox === "inbox" || mailbox === "archive" || mailbox === "snoozed") {
    actions.push({
      id: "snooze",
      label: mailbox === "snoozed" ? "Change snooze time" : "Snooze",
      text: mailbox === "snoozed" ? null : "Snooze",
      keys: keysFor("snooze"),
      group: "leave",
    });
  }
  actions.push({
    id: "trash",
    label: mailbox === "trash" ? "Delete permanently" : "Move to trash",
    text: mailbox === "trash" ? "Delete forever" : "Delete",
    keys: keysFor("trash"),
    group: "leave",
  });
  actions.push(
    {
      id: "read",
      label: state.unread ? "Mark read" : "Mark unread",
      text: null,
      keys: state.unread ? null : keysFor("toggleRead"),
      group: "toggle",
    },
    { id: "star", label: state.starred ? "Unstar" : "Star", text: null, keys: keysFor("toggleStar"), group: "toggle", pressed: state.starred },
  );
  return actions;
}

/**
 * The first key of a binding, for `aria-keyshortcuts` (`"# / ⌫"` → `"#"`). `null` when
 * there is none or it is not a plain key a screen reader could announce.
 */
export function ariaKey(keys: string | null): string | null {
  if (!keys) return null;
  const first = keys.split("/")[0]!.trim();
  return first.length === 1 ? first : null;
}

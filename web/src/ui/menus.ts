/**
 * What the two menus contain, as data.
 *
 * Built here rather than in JSX so the rules — which items a multi-selection hides, how
 * archive reads in each mailbox, when Unsubscribe appears — are unit-tested.
 *
 * The row menu is Gmail's, trimmed to what Winnow can actually do:
 *
 *   Reply · Reply all · Forward
 *   Archive · Delete · Mark as read/unread
 *   Move to ▸ · Mute sender
 *   Find emails from … · Find emails with this subject
 *   Open in Gmail
 *
 * Left out, deliberately: *Forward as attachment* (the composer sends text only), *Snooze*
 * and *Add to tasks* (no snooze store and no Tasks scope), *Label as* (Winnow has
 * mailboxes, not labels). Gmail's *Mute* mutes a conversation; Winnow has no thread mute,
 * so the slot is *Mute sender*, the same local mute the avatar menu offers.
 */

import {
  Archive,
  ArchiveRestore,
  AtSign,
  BellOff,
  Bell,
  Copy,
  ExternalLink,
  FolderInput,
  Forward,
  Inbox,
  Mail,
  MailOpen,
  MailMinus,
  Reply,
  ReplyAll,
  Search,
  ShieldAlert,
  Trash2,
  UserPlus,
  UserX,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { MenuEntry } from "./menuPlacement";
import { MAILBOX_LABEL, type Mailbox } from "../core/model/email";
import { shortcutFor, type Command } from "../core/mail/keybinds";

/** The first key a command is bound to, as a menu prints it: `# / ⌫` → `#`. */
export function menuHint(command: Command["type"]): string | undefined {
  const keys = shortcutFor(command);
  return keys ? (keys.split(" / ")[0] ?? keys) : undefined;
}

const divider = (id: string): MenuEntry => ({ kind: "divider", id });

/** Drop leading, trailing and doubled dividers left by omitted groups. */
export function tidy(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "divider" && (out.length === 0 || out[out.length - 1]!.kind === "divider")) continue;
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1]!.kind === "divider") out.pop();
  return out;
}

export type RowMenuInput = {
  /** How many messages the menu acts on: 1, or the size of the selection. */
  count: number;
  mailbox: Mailbox;
  /** Whether any target is unread, which decides read vs unread. */
  anyUnread: boolean;
  /** Single target only. */
  sender?: { name: string; address: string; muted: boolean };
  subject?: string;
  actions: {
    reply: () => void;
    replyAll: () => void;
    forward: () => void;
    archive: () => void;
    trash: () => void;
    setRead: (read: boolean) => void;
    move: (mailbox: Mailbox) => void;
    toggleMuteSender: () => void;
    findFrom: () => void;
    findSubject: () => void;
    openInGmail: () => void;
  };
};

/** What `archive` does in this mailbox, as a menu says it. `null` in Sent. */
export function archiveLabel(mailbox: Mailbox): { label: string; restore: boolean } | null {
  if (mailbox === "sent") return null;
  if (mailbox === "inbox") return { label: "Archive", restore: false };
  if (mailbox === "spam") return { label: "Not spam", restore: true };
  return { label: "Move to Inbox", restore: true };
}

/** Where "Move to" can send messages from `mailbox`. Sent is Gmail's, not a destination. */
export function moveTargets(mailbox: Mailbox): Mailbox[] {
  return (["inbox", "archive", "spam", "trash"] as const).filter((m) => m !== mailbox);
}

const MAILBOX_ICON: Record<Mailbox, LucideIcon> = {
  inbox: Inbox,
  archive: Archive,
  spam: ShieldAlert,
  trash: Trash2,
  sent: Mail,
};

export function buildRowMenu(input: RowMenuInput): MenuEntry[] {
  const { count, mailbox, actions } = input;
  const single = count === 1;
  const plural = single ? "" : ` ${count}`;
  const archive = archiveLabel(mailbox);
  const entries: MenuEntry[] = [];

  if (single && mailbox !== "trash" && mailbox !== "spam") {
    entries.push(
      { kind: "item", id: "reply", label: "Reply", icon: Reply, onSelect: actions.reply },
      // Winnow's `r` is reply-all (see `openReply`), so the hint sits here.
      { kind: "item", id: "reply-all", label: "Reply all", icon: ReplyAll, hint: menuHint("focusReply"), onSelect: actions.replyAll },
      { kind: "item", id: "forward", label: "Forward", icon: Forward, hint: menuHint("forward"), onSelect: actions.forward },
      divider("d1"),
    );
  }

  if (archive) {
    entries.push({
      kind: "item",
      id: "archive",
      label: single ? archive.label : `${archive.label}${plural}`,
      icon: archive.restore ? ArchiveRestore : Archive,
      hint: menuHint("archive"),
      onSelect: actions.archive,
    });
  }
  entries.push(
    {
      kind: "item",
      id: "trash",
      label: mailbox === "trash" ? (single ? "Delete forever" : `Delete${plural} forever`) : single ? "Delete" : `Delete${plural}`,
      icon: Trash2,
      danger: mailbox === "trash",
      hint: menuHint("trash"),
      onSelect: actions.trash,
    },
    input.anyUnread
      ? { kind: "item", id: "mark-read", label: "Mark as read", icon: MailOpen, hint: menuHint("toggleRead"), onSelect: () => actions.setRead(true) }
      : { kind: "item", id: "mark-unread", label: "Mark as unread", icon: MailMinus, hint: menuHint("toggleRead"), onSelect: () => actions.setRead(false) },
    divider("d2"),
    {
      kind: "item",
      id: "move",
      label: "Move to",
      icon: FolderInput,
      submenu: moveTargets(mailbox).map((target) => ({
        kind: "item" as const,
        id: `move-${target}`,
        label: MAILBOX_LABEL[target],
        icon: MAILBOX_ICON[target],
        onSelect: () => actions.move(target),
      })),
    },
  );

  if (single && input.sender) {
    entries.push({
      kind: "item",
      id: "mute-sender",
      label: input.sender.muted ? "Unmute sender" : "Mute sender",
      icon: input.sender.muted ? Bell : BellOff,
      onSelect: actions.toggleMuteSender,
    });
    entries.push(
      divider("d3"),
      { kind: "item", id: "find-from", label: `Find emails from ${input.sender.name}`, icon: AtSign, onSelect: actions.findFrom },
    );
    if (input.subject?.trim()) {
      entries.push({ kind: "item", id: "find-subject", label: "Find emails with this subject", icon: Search, onSelect: actions.findSubject });
    }
    entries.push(divider("d4"), {
      kind: "item",
      id: "open-gmail",
      label: "Open in Gmail",
      icon: ExternalLink,
      onSelect: actions.openInGmail,
    });
  }

  return tidy(entries);
}

export type SenderMenuInput = {
  name: string;
  address: string;
  muted: boolean;
  /** Already a saved Google contact: "Add to contacts" is not offered. */
  savedContact: boolean;
  /** From the message's `List-Unsubscribe`; Unsubscribe only appears with one. */
  canUnsubscribe: boolean;
  actions: {
    showAll: () => void;
    toggleMute: () => void;
    block: () => void;
    addToContacts: () => void;
    unsubscribe: () => void;
    copyAddress: () => void;
  };
};

export function buildSenderMenu(input: SenderMenuInput): MenuEntry[] {
  const { actions } = input;
  const entries: MenuEntry[] = [
    { kind: "item", id: "sender-all", label: "All mail from this sender", icon: Search, onSelect: actions.showAll },
    { kind: "item", id: "sender-copy", label: "Copy address", icon: Copy, onSelect: actions.copyAddress },
  ];
  if (!input.savedContact) {
    entries.push({ kind: "item", id: "sender-contact", label: "Add to contacts", icon: UserPlus, onSelect: actions.addToContacts });
  }
  entries.push(divider("s1"));
  if (input.canUnsubscribe) {
    entries.push({ kind: "item", id: "sender-unsubscribe", label: "Unsubscribe", icon: MailMinus, onSelect: actions.unsubscribe });
  }
  entries.push(
    {
      kind: "item",
      id: "sender-mute",
      label: input.muted ? "Unmute sender" : "Mute sender",
      icon: input.muted ? Bell : BellOff,
      onSelect: actions.toggleMute,
    },
    { kind: "item", id: "sender-block", label: "Block sender", icon: UserX, danger: true, onSelect: actions.block },
  );
  return tidy(entries);
}

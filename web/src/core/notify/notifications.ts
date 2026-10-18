/**
 * New-mail notifications: which messages earn one, what it says, and what its buttons
 * do when the host hands a press back.
 *
 * Pure. The store decides *when* (new arrivals after a sync); this decides *which* and
 * *what*; the platform shows it (`platform/desktop.ts` → `notify_messages` in Rust,
 * `platform/web.ts` → `Notification`). The buttons and where they run are in
 * `native/src-tauri/src/notify_actions/mod.rs` and MAP.md §8.3.
 */

import type { Draft, Email } from "../model/email";
import { displayName } from "../model/email";
import { replySubject } from "../mail/reply";

/** Per-message notifications at most; the rest are counted in the summary. Rust caps it too. */
export const MAX_MESSAGE_NOTIFICATIONS = 5;

/** Which buttons a notification offers. All on by default. */
export type NotificationActions = {
  reply: boolean;
  trash: boolean;
  read: boolean;
};

export const DEFAULT_NOTIFICATION_ACTIONS: NotificationActions = { reply: true, trash: true, read: true };

/** The settings that shape a notification (a slice of `Preferences`). */
export type NotificationSettings = {
  notificationActions: NotificationActions;
  /** Lock screen shows "New message" rather than sender and subject. */
  notificationHidePreview: boolean;
  mutedSenders: readonly string[];
  blockedSenders: readonly string[];
};

/** One message's notification, on the wire to the platform (camelCase, as Rust reads it). */
export type MessageNotice = {
  messageId: number;
  gmailId: string;
  threadId: string | null;
  title: string;
  subject: string;
  preview: string;
  receivedAt: number;
  /** The composer's header block for a reply; `null` means no inline reply. */
  replyHead: string | null;
};

export type NotificationBatch = {
  total: number;
  summaryTitle: string;
  summaryBody: string;
  messages: MessageNotice[];
  actions: NotificationActions;
  hidePreview: boolean;
};

/**
 * The messages that may notify, newest first.
 *
 * Only mail that is still unread, in the inbox, and from a sender the user has neither
 * muted nor hidden. A message read on another device before this sync saw it, or
 * filed away by a filter, is not news.
 */
export function notifiable(emails: readonly Email[], settings: Pick<NotificationSettings, "mutedSenders" | "blockedSenders">): Email[] {
  const quiet = new Set([...settings.mutedSenders, ...settings.blockedSenders].map((s) => s.toLowerCase()));
  return emails
    .filter((email) => email.unread && email.mailbox === "inbox" && !quiet.has(email.sender.toLowerCase()))
    .sort((a, b) => b.receivedAt - a.receivedAt);
}

/** The first line worth reading, short. */
export function previewOf(email: Email): string {
  const line = email.body
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !part.startsWith(">"));
  if (!line) return "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/**
 * The batch for one sync's arrivals. `emails` should already be `notifiable`; the
 * newest `MAX_MESSAGE_NOTIFICATIONS` get their own notification, and the summary
 * counts them all.
 */
export function buildNotificationBatch(
  emails: readonly Email[],
  settings: Pick<NotificationSettings, "notificationActions" | "notificationHidePreview">,
  replyHeads: Readonly<Record<string, string>> = {},
): NotificationBatch {
  const shown = emails.slice(0, MAX_MESSAGE_NOTIFICATIONS);
  const total = emails.length;
  const names = [...new Set(emails.map((email) => displayName(email)))];
  return {
    total,
    summaryTitle: total === 1 ? displayName(emails[0]) : `${total} new messages`,
    summaryBody:
      total === 1
        ? emails[0].subject
        : names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : ""),
    messages: shown.map((email) => ({
      messageId: email.id,
      gmailId: email.gmailId,
      threadId: email.threadId ?? null,
      title: displayName(email),
      subject: email.subject,
      preview: previewOf(email),
      receivedAt: email.receivedAt,
      replyHead: settings.notificationActions.reply ? replyHeads[email.gmailId] ?? null : null,
    })),
    actions: { ...settings.notificationActions },
    hidePreview: settings.notificationHidePreview,
  };
}

/**
 * The reply a notification sends: to the sender, `Re:` the subject, on its thread.
 *
 * Reply-to-sender rather than the composer's reply-all default: a one-line answer typed
 * into a notification has no visible To field to check, and reply-all is the kind of
 * mistake that cannot be taken back. The body is empty here: the session builds the
 * header block from this (`rawFor` → `buildMime`, the composer's own path), and the
 * native side appends the typed text.
 */
export function notificationReplyDraft(email: Email, body = ""): Draft {
  return {
    to: [email.sender],
    cc: [],
    bcc: [],
    subject: replySubject(email.subject),
    body,
    inReplyTo: email.gmailId,
    threadId: email.threadId,
    prefilled: "",
  };
}

// ── Presses ────────────────────────────────────────────────────────────────

export type NotificationActionName = "open" | "reply" | "read" | "trash" | "untrash";

/** A press, as the platform reports it. */
export type NotificationActionEvent = {
  action: NotificationActionName;
  messageId: number;
  gmailId: string;
  /**
   * `desktop` and `web`: nothing has happened yet, the app should do it. `android`: the
   * native side already did it (in the background, with the stored token).
   */
  origin: "desktop" | "web" | "android";
  outcome?: "done" | "failed";
};

const ACTIONS: readonly NotificationActionName[] = ["open", "reply", "read", "trash", "untrash"];

/** Validate what came over IPC; anything unexpected is dropped, never guessed at. */
export function parseNotificationAction(raw: unknown): NotificationActionEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const action = source.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) return null;
  const messageId = source.messageId;
  if (typeof messageId !== "number" || !Number.isSafeInteger(messageId)) return null;
  const origin = source.origin;
  if (origin !== "desktop" && origin !== "web" && origin !== "android") return null;
  const gmailId = typeof source.gmailId === "string" ? source.gmailId : "";
  const outcome = source.outcome === "done" || source.outcome === "failed" ? source.outcome : undefined;
  return { action: action as NotificationActionName, messageId, gmailId, origin, ...(outcome ? { outcome } : {}) };
}

/** What the handler needs from the app. All of it already exists for the app's own buttons. */
export type NotificationActionDeps = {
  focusWindow(): Promise<void> | void;
  /** Select and open a message; `false` when it is not cached. */
  focusMessage(id: number): boolean;
  /** Open the composer on a reply to the open message. */
  openReply(): void;
  /** Whether a message is cached, unread, and where. */
  find(id: number): Pick<Email, "id" | "unread" | "mailbox"> | undefined;
  setRead(id: number, read: boolean): void;
  /** Move to Trash with Undo (`moveWithUndo`), never a permanent delete. */
  trashWithUndo(id: number): void;
  refresh(): Promise<void> | void;
  /** Desktop: the short confirmation on the notification. */
  confirm?(messageId: number, title: string, text: string, failed: boolean): void;
};

/**
 * Act on a press. Returns what was done, for the tests and the log.
 *
 * Android presses arrive already done, so the app only refreshes to show it. Desktop
 * and browser presses are done here, through the same store calls as the app's own
 * buttons, so Undo, rollback on failure and the error strip all come with them.
 */
export function handleNotificationAction(event: NotificationActionEvent, deps: NotificationActionDeps): string {
  if (event.origin === "android") {
    void deps.refresh();
    return `refreshed after ${event.action}`;
  }
  switch (event.action) {
    case "open":
      void deps.focusWindow();
      return deps.focusMessage(event.messageId) ? "opened" : "focused";
    case "reply":
      void deps.focusWindow();
      if (!deps.focusMessage(event.messageId)) return "focused";
      deps.openReply();
      return "reply opened";
    case "read": {
      const email = deps.find(event.messageId);
      if (!email) {
        deps.confirm?.(event.messageId, "Couldn't do that. Open Winnow", "That message isn't loaded yet.", true);
        return "not cached";
      }
      deps.setRead(event.messageId, true);
      deps.confirm?.(event.messageId, "Marked as read", "", false);
      return "marked read";
    }
    case "trash": {
      const email = deps.find(event.messageId);
      if (!email || email.mailbox === "trash") {
        deps.confirm?.(event.messageId, "Couldn't do that. Open Winnow", "That message isn't loaded yet.", true);
        return "not cached";
      }
      deps.trashWithUndo(event.messageId);
      deps.confirm?.(event.messageId, "Moved to Trash", "Undo is in Winnow.", false);
      return "trashed";
    }
    case "untrash":
      // Only Android offers Undo on the notification itself.
      return "ignored";
  }
}

// ── Replies the phone kept ────────────────────────────────────────────────

/** A reply the Android side could neither send nor save (`PendingReplies.kt`). */
export type KeptReply = {
  /** The press it came from; how the phone's copy is released once saved. */
  requestId: string;
  gmailId: string;
  threadId: string | null;
  messageId: number;
  title: string;
  subject: string;
  replyHead: string | null;
  reply: string;
  at: number;
};

export function parseKeptReply(raw: unknown): KeptReply | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.reply !== "string" || s.reply.trim().length === 0) return null;
  if (typeof s.gmailId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(s.gmailId)) return null;
  if (typeof s.requestId !== "string" || s.requestId.length === 0) return null;
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    requestId: s.requestId,
    gmailId: s.gmailId,
    threadId: typeof s.threadId === "string" && s.threadId ? s.threadId : null,
    messageId: typeof s.messageId === "number" && Number.isSafeInteger(s.messageId) ? s.messageId : 0,
    title: str(s.title),
    subject: str(s.subject),
    replyHead: typeof s.replyHead === "string" ? s.replyHead : null,
    reply: s.reply,
    at: typeof s.at === "number" ? s.at : 0,
  };
}

/** The `To:` of a reply head, for a kept reply whose original is no longer cached. */
export function recipientOfHead(head: string | null): string | null {
  if (!head) return null;
  const line = head.split("\r\n").find((part) => part.startsWith("To: "));
  const to = line?.slice(4).split(",")[0]?.trim();
  return to && to.includes("@") ? to : null;
}

/**
 * The draft a kept reply becomes. With the original cached it is the notification's
 * own reply; without it, the recipient and thread the head named, so it still threads
 * (`Draft.replyHeaders`).
 */
export function draftForKeptReply(kept: KeptReply, original: Email | undefined): Draft | null {
  if (original) return notificationReplyDraft(original, kept.reply);
  const to = recipientOfHead(kept.replyHead);
  if (!to) return null;
  const inReplyTo = kept.replyHead?.split("\r\n").find((line) => line.startsWith("In-Reply-To: "))?.slice(13).trim();
  const references = kept.replyHead?.split("\r\n").find((line) => line.startsWith("References: "))?.slice(12).trim();
  return {
    to: [to],
    cc: [],
    bcc: [],
    subject: replySubject(kept.subject),
    body: kept.reply,
    threadId: kept.threadId ?? undefined,
    prefilled: "",
    ...(inReplyTo ? { replyHeaders: { inReplyTo, ...(references ? { references } : {}) } } : {}),
  };
}

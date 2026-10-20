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
import { isAccountId } from "../session/accounts";
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
  /**
   * The sender's picture, resolved exactly as the app's avatar is under the current
   * settings (`resolveSenderPicture` in `ui/senderPictures.ts`); `null` for none (the
   * app icon), and always `null` while lock-screen previews are hidden.
   */
  picture: string | null;
};

/**
 * Whose mail it is (1.4.0): every press names the account, so it acts on that account
 * and opens its inbox. `label` is the address, shown on the notification only when more
 * than one account is signed in (`null` otherwise, and in the demo).
 */
export type NotificationAccount = { id: string; label: string | null };

export type NotificationBatch = {
  account?: NotificationAccount | null;
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
  pictures: Readonly<Record<string, string>> = {},
  account: NotificationAccount | null = null,
): NotificationBatch {
  const shown = emails.slice(0, MAX_MESSAGE_NOTIFICATIONS);
  const total = emails.length;
  const names = [...new Set(emails.map((email) => displayName(email)))];
  return {
    account: account && isAccountId(account.id) ? { id: account.id, label: account.label } : null,
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
      // Who it is from is exactly what a hidden preview hides; a face or a logo says it.
      picture: settings.notificationHidePreview ? null : pictures[email.gmailId] ?? null,
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

/** `inbox`: the summary of several messages was pressed, which opens the account's inbox. */
export type NotificationActionName = "open" | "reply" | "read" | "trash" | "untrash" | "inbox";

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
  /** The account the notification was for (1.4.0); absent from an older native build. */
  account?: string;
};

const ACTIONS: readonly NotificationActionName[] = ["open", "reply", "read", "trash", "untrash", "inbox"];

/** Validate what came over IPC; anything unexpected is dropped, never guessed at. */
export function parseNotificationAction(raw: unknown): NotificationActionEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const action = source.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) return null;
  const messageId = source.messageId;
  if (typeof messageId !== "number" || !Number.isSafeInteger(messageId)) return null;
  // A summary names no message (`messageId` 0).
  const origin = source.origin;
  if (origin !== "desktop" && origin !== "web" && origin !== "android") return null;
  const gmailId = typeof source.gmailId === "string" ? source.gmailId : "";
  const outcome = source.outcome === "done" || source.outcome === "failed" ? source.outcome : undefined;
  const account = isAccountId(source.account) ? source.account : undefined;
  return {
    action: action as NotificationActionName,
    messageId,
    gmailId,
    origin,
    ...(outcome ? { outcome } : {}),
    ...(account ? { account } : {}),
  };
}

/** What the handler needs from the app. All of it already exists for the app's own buttons. */
export type NotificationActionDeps = {
  focusWindow(): Promise<void> | void;
  /**
   * Make `account` the open one (1.4.0), resolving once its mail is there; `false` when
   * this device has no such account any more. Absent: one account, nothing to switch.
   */
  openAccount?(account: string): Promise<boolean>;
  /** Whether `account` is the open one. */
  isOpen?(account: string): boolean;
  /**
   * Open a message in the reader: the cached copy, or fetched first when it is not
   * cached yet (`store.openMessage`). `false` when it cannot be found.
   */
  openMessage(gmailId: string, id: number): Promise<boolean> | boolean;
  /** The inbox, as the summary of several messages opens it. */
  openInbox(): void;
  /** Open the composer on a reply to the open message. */
  openReply(): void;
  /** Whether a message is cached (fetched when it is not), unread, and where. */
  find(id: number, gmailId: string): Promise<Pick<Email, "id" | "unread" | "mailbox"> | undefined> | Pick<Email, "id" | "unread" | "mailbox"> | undefined;
  setRead(id: number, read: boolean): void;
  /** Move to Trash with Undo (`moveWithUndo`), never a permanent delete. */
  trashWithUndo(id: number): void;
  refresh(): Promise<void> | void;
  /** An account that is not open did something natively: its light sync catches up. */
  refreshAccount?(account: string): Promise<void> | void;
  /** Desktop: the short confirmation on the notification. */
  confirm?(messageId: number, title: string, text: string, failed: boolean): void;
};

/**
 * Act on a press. Resolves to what was done, for the tests and the log.
 *
 * Android presses arrive already done, so the app only refreshes to show it. Desktop
 * and browser presses are done here, through the same store calls as the app's own
 * buttons, so Undo, rollback on failure and the error strip all come with them — after
 * the notification's account is made the open one, so the press acts on the account the
 * mail arrived in and leaves its inbox on screen.
 */
export async function handleNotificationAction(event: NotificationActionEvent, deps: NotificationActionDeps): Promise<string> {
  if (event.origin === "android" && event.action !== "open" && event.action !== "inbox") {
    if (event.account && deps.isOpen && !deps.isOpen(event.account)) {
      void deps.refreshAccount?.(event.account);
      return `refreshed ${event.account} after ${event.action}`;
    }
    void deps.refresh();
    return `refreshed after ${event.action}`;
  }
  const visible = event.action === "open" || event.action === "reply" || event.action === "inbox";
  if (visible) void deps.focusWindow();
  if (event.account && deps.openAccount && !(await deps.openAccount(event.account))) {
    deps.confirm?.(event.messageId, "Couldn't do that. Open Winnow", "That account isn't signed in on this device any more.", true);
    return "unknown account";
  }
  switch (event.action) {
    case "inbox":
      deps.openInbox();
      return "inbox opened";
    case "open":
      return (await deps.openMessage(event.gmailId, event.messageId)) ? "opened" : "focused";
    case "reply":
      if (!(await deps.openMessage(event.gmailId, event.messageId))) return "focused";
      deps.openReply();
      return "reply opened";
    case "read": {
      const email = await deps.find(event.messageId, event.gmailId);
      if (!email) {
        deps.confirm?.(event.messageId, "Couldn't do that. Open Winnow", "That message isn't loaded yet.", true);
        return "not cached";
      }
      deps.setRead(email.id, true);
      deps.confirm?.(event.messageId, "Marked as read", "", false);
      return "marked read";
    }
    case "trash": {
      const email = await deps.find(event.messageId, event.gmailId);
      if (!email || email.mailbox === "trash") {
        deps.confirm?.(event.messageId, "Couldn't do that. Open Winnow", "That message isn't loaded yet.", true);
        return "not cached";
      }
      deps.trashWithUndo(email.id);
      deps.confirm?.(event.messageId, "Moved to Trash", "Undo is in Winnow.", false);
      return "trashed";
    }
    case "untrash":
      // Only Android offers Undo on the notification itself.
      return "ignored";
  }
}

// ── Deep links ─────────────────────────────────────────────────────────────

/**
 * What a `winnow://` link asks for. A notification's tap is
 * `winnow://message/<id>?account=<acct>&gmail=<gmailId>` (one message) or
 * `winnow://open?account=<acct>&view=inbox` (a summary of several); 1.3.5's
 * `winnow://message/<id>` and `winnow://open` still read.
 */
export type DeepLink =
  | { kind: "message"; messageId: number; gmailId: string; account?: string }
  | { kind: "inbox"; account?: string }
  | { kind: "signed-in" }
  | { kind: "open" };

export function parseDeepLink(raw: string): DeepLink | null {
  const url = raw.trim();
  if (/^winnow:\/\/signed-in\/?$/.test(url)) return { kind: "signed-in" };
  const match = /^winnow:\/\/(message\/(\d+)|open)\/?(?:\?(.*))?$/.exec(url);
  if (!match) return null;
  const params = new URLSearchParams(match[3] ?? "");
  const account = params.get("account");
  const tagged = isAccountId(account) ? { account } : {};
  if (match[2] !== undefined) {
    const messageId = Number(match[2]);
    if (!Number.isSafeInteger(messageId)) return null;
    const gmail = params.get("gmail") ?? "";
    return { kind: "message", messageId, gmailId: /^[A-Za-z0-9]{1,64}$/.test(gmail) ? gmail : "", ...tagged };
  }
  if (params.get("view") === "inbox" || account) return { kind: "inbox", ...tagged };
  return { kind: "open" };
}

/** The link a notification's tap carries, as the native side builds it (pinned by tests on both sides). */
export function messageLink(messageId: number, gmailId: string, account?: string | null): string {
  const query = new URLSearchParams();
  if (account) query.set("account", account);
  if (gmailId) query.set("gmail", gmailId);
  const rest = query.toString();
  return `winnow://message/${messageId}${rest ? `?${rest}` : ""}`;
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
  /** The account the notification was for (1.4.0); saved into that account's Drafts only. */
  account?: string;
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
    ...(isAccountId(s.account) ? { account: s.account } : {}),
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

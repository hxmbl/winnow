/**
 * Dev Options → Send test notification: a sample new-mail notification posted through
 * the real path (`announce` in `ui/notificationActions.ts` → the platform's batch → the
 * native notifier), so the layout, the large icon and the buttons can be checked
 * without waiting for mail.
 *
 * The sample is not a message. Its Gmail id, `TEST_GMAIL_ID`, is not hex, so it can
 * never be a real Gmail id, and every press on it is a no-op against real mail:
 *
 * - **Android** (presses done natively): `plan::execute` in
 *   `native/src-tauri/src/notify_actions/plan.rs` checks the same id (`TEST_GMAIL_ID`
 *   there; a test pins the two together) and answers before any token is read or any
 *   request is made; the notification says "Test notification · Nothing was changed".
 * - **Desktop and browser** (presses done by the app): `routeNotificationAction`
 *   recognises it and does nothing but say so.
 * - **A reply kept on the phone** (Android restarted the app just to deliver the press):
 *   `saveKeptReplies` releases it without saving it to Drafts.
 *
 * Either way the app says what happened with `testPressText` in the status pill.
 */

import type { Email } from "../model/email";
import { hashId } from "../model/ids";
import type { NotificationActionName } from "./notifications";

/** The sample's Gmail id. Not hex (real Gmail ids are), so it is never a real message. Same as Rust's. */
export const TEST_GMAIL_ID = "winnowtestnotification";

/** The sample's app id, as the mapper would derive it from that Gmail id. */
export const TEST_MESSAGE_ID = hashId(TEST_GMAIL_ID);

/**
 * A reply header block for the sample, so Android offers its inline Reply (it shows the
 * button only when a message has one, and Rust keeps only a head `assemble_reply`
 * accepts). Never sent: the native side stops at the test id, and it is addressed to
 * `.invalid`, which no mail system delivers to. Rust's tests check the same text.
 */
export const TEST_REPLY_HEAD =
  "From: Winnow <test@winnow.invalid>\r\nTo: test@winnow.invalid\r\nSubject: Re: Test notification\r\nIn-Reply-To: <winnowtestnotification@winnow.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n";

export function isTestNotification(gmailId: string | null | undefined): boolean {
  return gmailId === TEST_GMAIL_ID;
}

/** The sample message, from Winnow itself (a monogram "W" unless a picture is found). */
export function testNotificationEmail(now: number = Date.now()): Email {
  return {
    id: TEST_MESSAGE_ID,
    gmailId: TEST_GMAIL_ID,
    sender: "test@winnow.invalid",
    name: "Winnow",
    mailbox: "inbox",
    receivedAt: now,
    subject: "Test notification",
    body: "This is a sample from Dev Options. Delete, Mark read and Reply do nothing to your mail.",
    category: "primary",
    starred: false,
    unread: true,
    attachments: [],
    urgent: false,
  };
}

const PRESSED: Record<NotificationActionName, string> = {
  open: "Opening it",
  inbox: "Opening it",
  reply: "Reply",
  read: "Mark read",
  trash: "Delete",
  untrash: "Undo",
};

/** What the app says after a press on the sample. */
export function testPressText(action: NotificationActionName): string {
  return `Test notification: ${PRESSED[action]} did nothing. It isn't a real message.`;
}

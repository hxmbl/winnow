/**
 * Send later: a message written now and sent at a chosen time.
 *
 * Gmail's API has no scheduled send (Gmail's own is not exposed), so the message waits
 * as an ordinary **Gmail draft** — the composer has already saved it there — and the
 * time is kept **on this device** (`winnow.scheduledSend.v1`, `keyedStorage`). At the
 * time the app sends it through the same path Send uses after its undo window
 * (`App.deliver`: Drive links shared at dispatch, `drafts.send`, the offline queue).
 *
 * **Winnow has to be running to send it.** Nothing on Google's side knows about the
 * schedule. If the app is closed at the time, the message goes the next time Winnow is
 * opened, and the status pill says it went late. The Send later menu and Settings say so.
 *
 * Each record keeps a device copy of the draft (attachments within the drafts' device
 * budget, `forDeviceCopy`), so a reply keeps its threading and the demo, which has no
 * Gmail drafts, can simulate it. A draft whose files did not fit the device copy needs
 * the app to have stayed open, or the Gmail draft to be reopened (Edit) to send.
 *
 * Pure record keeping; `App.tsx` does the sending.
 */

import type { Draft, Email, GmailId, Millis } from "../model/email";
import { hashId } from "../model/ids";
import { forDeviceCopy } from "./attachments";
import type { DraftMode } from "./drafts";

/** How long a claim on a due send holds off another window of the app from sending it too. */
export const CLAIM_MS = 2 * 60 * 1000;

export type ScheduledSend = {
  /** Local id. */
  id: string;
  /** Whose message: the account address, or `demo`. Only that account sends it. */
  account: string;
  /**
   * The account id it goes out from, when the composer's From was another signed-in
   * account than `account` (its Gmail draft is that account's). Absent: from `account`.
   */
  from?: string;
  sendAt: Millis;
  scheduledAt: Millis;
  mode: DraftMode;
  /** The composer context it was written in (`draftContextKey`). */
  context: string;
  /** The message a reply or forward answers (it threads on it). */
  replyTo?: GmailId;
  replyAll?: boolean;
  /** The Gmail draft that is sent, or `null` (the demo, or a draft Gmail did not take). */
  draftId: string | null;
  /** The message as it will go out. */
  draft: Draft;
  /** What the user already answered about its Drive links. */
  drive?: { accepted?: boolean; waived?: boolean };
  /** Set while a window of the app is sending it. */
  claimedAt?: Millis;
  /** Why it did not go, when it could not (it then waits for Send now or Edit). */
  problem?: string;
};

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function isDraft(value: unknown): value is Draft {
  const draft = value as Partial<Draft> | null;
  return (
    !!draft &&
    Array.isArray(draft.to) &&
    Array.isArray(draft.cc) &&
    Array.isArray(draft.bcc) &&
    isString(draft.subject) &&
    isString(draft.body)
  );
}

/** Whatever storage held, read tolerantly. */
export function parseSchedules(raw: unknown): ScheduledSend[] {
  const list = raw && typeof raw === "object" ? (raw as { sends?: unknown }).sends : null;
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry): entry is ScheduledSend => {
      const r = entry as Partial<ScheduledSend>;
      return (
        !!r &&
        isString(r.id) &&
        isString(r.account) &&
        isNumber(r.sendAt) &&
        isNumber(r.scheduledAt) &&
        (r.mode === "new" || r.mode === "reply" || r.mode === "forward") &&
        isString(r.context) &&
        (r.draftId === null || isString(r.draftId)) &&
        (r.from === undefined || isString(r.from)) &&
        isDraft(r.draft)
      );
    })
    .sort((a, b) => a.sendAt - b.sendAt);
}

/** What storage keeps: the list, under a key so the shape can grow. */
export function serializeSchedules(sends: readonly ScheduledSend[]): { sends: ScheduledSend[] } {
  return {
    sends: sends.map((send) => {
      const attachments = forDeviceCopy(send.draft.attachments);
      const { attachments: _all, ...rest } = send.draft;
      void _all;
      return { ...send, draft: attachments ? { ...rest, attachments } : rest };
    }),
  };
}

/**
 * Add a schedule. One per draft: scheduling the same Gmail draft (or, with none, the same
 * composer context) again replaces the earlier time.
 */
export function addSchedule(sends: readonly ScheduledSend[], send: ScheduledSend): ScheduledSend[] {
  const rest = sends.filter(
    (other) =>
      other.id !== send.id &&
      !(other.account === send.account && (send.draftId ? other.draftId === send.draftId : other.context === send.context && !other.draftId)),
  );
  return [...rest, send].sort((a, b) => a.sendAt - b.sendAt);
}

export function removeSchedule(sends: readonly ScheduledSend[], id: string): ScheduledSend[] {
  return sends.filter((send) => send.id !== id);
}

export function updateSchedule(
  sends: readonly ScheduledSend[],
  id: string,
  patch: Partial<Pick<ScheduledSend, "claimedAt" | "problem" | "sendAt" | "draftId">>,
): ScheduledSend[] {
  return sends.map((send) => {
    if (send.id !== id) return send;
    const next = { ...send, ...patch };
    // `undefined` in a patch means "clear it", not "keep it".
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (patch[key] === undefined) delete next[key];
    return next;
  });
}

/**
 * This account's sends whose time has come: not waiting on the user (`problem`) and not
 * being sent by another window right now (`claimedAt` within `CLAIM_MS`).
 */
export function dueSchedules(sends: readonly ScheduledSend[], account: string, now: Millis): ScheduledSend[] {
  return sends.filter(
    (send) =>
      send.account === account &&
      send.sendAt <= now &&
      send.problem === undefined &&
      (send.claimedAt === undefined || now - send.claimedAt > CLAIM_MS),
  );
}

/** What may be done with a due send in the account that is open now. */
export type ScheduleVerdict = "send" | "skip" | "drop";

/**
 * Whether a send may go out now, checked again right before it is dispatched:
 * `skip` for anything not listed under the open account (another account's, the
 * demo's: never sent from here, kept for its owner); `drop` when an account it names is
 * no longer signed in here (the open one gone from the registry, or the `from` account
 * removed): it can never go as written, so it is ended rather than sent from someone
 * else. `openId` null with no registry is the demo, or a store without accounts (tests).
 */
export function scheduleVerdict(
  send: Pick<ScheduledSend, "account" | "from">,
  open: { account: string; openId: string | null; accounts: readonly { id: string }[] },
): ScheduleVerdict {
  if (!open.account || send.account.trim().toLowerCase() !== open.account.trim().toLowerCase()) return "skip";
  if (open.account === "demo") return "send";
  const here = (id: string) => open.accounts.some((account) => account.id === id);
  if (open.openId !== null && !here(open.openId)) return "drop";
  if (send.from !== undefined && send.from !== open.openId && !here(send.from)) return "drop";
  return "send";
}

/**
 * Forget one account's sends: those listed under its address and those going out from
 * it (`from`, its id). What an account leaves behind, as it is signed out or removed.
 */
export function forgetAccountSchedules(sends: readonly ScheduledSend[], address: string, id?: string): ScheduledSend[] {
  const gone = address.trim().toLowerCase();
  return sends.filter(
    (send) => !((gone !== "" && send.account.trim().toLowerCase() === gone) || (id !== undefined && send.from === id)),
  );
}

/** A new local id, unique enough for one device's handful of schedules. */
export function newScheduleId(now: Millis): string {
  return `sched-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The Scheduled mailbox's row for a send: dated by when it goes, from the user, and
 * carrying `scheduled` so the row and the menu know what it is. Never in `state.all`.
 */
export function scheduledRow(send: ScheduledSend, self: { email: string; name?: string }): Email {
  const gmailId = `scheduled-${send.id}`;
  const contacts = (addresses: readonly string[]) => addresses.map((address) => ({ address }));
  return {
    id: hashId(gmailId),
    gmailId,
    threadId: send.draft.threadId,
    sender: self.email,
    address: self.email,
    name: self.name,
    to: contacts(send.draft.to),
    cc: contacts(send.draft.cc),
    bcc: contacts(send.draft.bcc),
    mailbox: "scheduled",
    receivedAt: send.sendAt,
    subject: send.draft.subject,
    body: send.draft.body,
    category: "primary",
    starred: false,
    unread: false,
    urgent: false,
    attachments: [],
    code: null,
    scheduled: { id: send.id, sendAt: send.sendAt, ...(send.problem ? { problem: send.problem } : {}) },
  };
}

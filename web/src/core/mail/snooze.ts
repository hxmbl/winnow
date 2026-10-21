/**
 * Snooze: hide a conversation until a chosen time, then bring it back to the top of the
 * Inbox, unread.
 *
 * Gmail's API has no snooze (Gmail's own is not exposed), so Winnow builds one from what
 * the API does have:
 *
 *   - **Snoozing archives** the conversation's inbox messages (removes `INBOX`) and gives
 *     them the label `Winnow/Snoozed`, made on first use, so they are visible and easy to
 *     find from any other client (and nothing is lost if this device goes away).
 *   - **The wake time is kept on this device** (`winnow.snooze.v1`, `keyedStorage`).
 *   - **Waking** re-adds `INBOX` and `UNREAD` and takes the label off. It happens when
 *     the app starts, on every sync (the 10 s poll while focused), on focus, and on a
 *     timer while open; if the app was closed at the time, on the next open.
 *   - **A woken message sorts by its wake time**, not by when it arrived (`overlay`
 *     below), and keeps that place while it stays in the Inbox, for up to a week.
 *   - **A new message in a snoozed conversation wakes it early**, as Gmail's does.
 *
 * This file is the record keeping, pure: parse, add, remove, what is due, what woke, and
 * the overlay the store lays over every reading of the mailbox. The store does the
 * moving (`WinnowStore.snooze`, `wakeDue`); the session does the labels (`setSnoozed`).
 */

import type { Email, GmailId, Mailbox, Millis } from "../model/email";
import { mergeRecords } from "../store/mergeRecords";

/** The Gmail label snoozed mail carries while it is away. */
export const SNOOZED_LABEL = "Winnow/Snoozed";

/** How long a woken message keeps its wake time as its place in the list. */
export const WOKE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A recorded snooze must have been made at least this long ago before a new message in
 * its conversation counts as a reply that wakes it: a sync that lands just after the
 * snooze can still list the conversation's own messages as they were.
 */
export const EARLY_WAKE_GRACE_MS = 60 * 1000;

/** One snoozed conversation. */
export type SnoozeRecord = {
  /** The conversation: its Gmail thread id, or the message id for a lone message. */
  key: string;
  /** Whose mail it is: the account address, or `demo`. Only that account wakes it. */
  account: string;
  /** The messages that were snoozed (the conversation's inbox messages at the time). */
  gmailIds: GmailId[];
  wakeAt: Millis;
  snoozedAt: Millis;
  /** Where they were snoozed from, for Undo. */
  from: Mailbox;
  /** For the Snoozed list when a message is not in the cache any more. */
  subject?: string;
};

/** A message that woke, and when: its place at the top of the Inbox. */
export type WokeRecord = { gmailId: GmailId; account: string; wokeAt: Millis };

export type SnoozeState = {
  snoozed: readonly SnoozeRecord[];
  woke: readonly WokeRecord[];
};

export const EMPTY_SNOOZES: SnoozeState = { snoozed: [], woke: [] };

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Whatever storage held, read tolerantly: a bad entry is dropped, never thrown. */
export function parseSnoozes(raw: unknown): SnoozeState {
  if (!raw || typeof raw !== "object") return EMPTY_SNOOZES;
  const value = raw as { snoozed?: unknown; woke?: unknown };
  const snoozed = (Array.isArray(value.snoozed) ? value.snoozed : []).filter((entry): entry is SnoozeRecord => {
    const r = entry as Partial<SnoozeRecord>;
    return (
      !!r &&
      isString(r.key) &&
      isString(r.account) &&
      Array.isArray(r.gmailIds) &&
      r.gmailIds.length > 0 &&
      r.gmailIds.every(isString) &&
      isNumber(r.wakeAt) &&
      isNumber(r.snoozedAt) &&
      isString(r.from)
    );
  });
  const woke = (Array.isArray(value.woke) ? value.woke : []).filter((entry): entry is WokeRecord => {
    const r = entry as Partial<WokeRecord>;
    return !!r && isString(r.gmailId) && isString(r.account) && isNumber(r.wokeAt);
  });
  return { snoozed, woke };
}

/**
 * This window's snoozes merged with what storage holds now, which another window of the
 * app may have written since `base` was read (STRM-290; `mergeRecords` has the rules).
 */
export function mergeSnoozes(base: SnoozeState, mine: SnoozeState, theirs: SnoozeState): SnoozeState {
  const snoozed = mergeRecords(base.snoozed, mine.snoozed, theirs.snoozed, {
    keyOf: (record) => `${record.account}\n${record.key}`,
  }).sort((a, b) => a.wakeAt - b.wakeAt);
  const woke = mergeRecords(base.woke, mine.woke, theirs.woke, {
    keyOf: (record) => `${record.account}\n${record.gmailId}`,
  });
  return { snoozed, woke };
}

/** The conversation a message snoozes with. */
export function snoozeKeyFor(email: Pick<Email, "threadId" | "gmailId">): string {
  return email.threadId ?? email.gmailId;
}

/** Add (or replace) a snooze. A message snoozed again leaves its older record. */
export function addSnooze(state: SnoozeState, record: SnoozeRecord): SnoozeState {
  const ids = new Set(record.gmailIds);
  const snoozed = state.snoozed
    .map((other) =>
      other.account !== record.account ? other : { ...other, gmailIds: other.gmailIds.filter((id) => !ids.has(id)) },
    )
    .filter((other) => other.gmailIds.length > 0 && !(other.account === record.account && other.key === record.key));
  // Snoozing again is not waking: a woken message snoozed again leaves the top.
  const woke = state.woke.filter((entry) => !(entry.account === record.account && ids.has(entry.gmailId)));
  return { snoozed: [...snoozed, record].sort((a, b) => a.wakeAt - b.wakeAt), woke };
}

/** Forget one snooze (unsnoozed by hand, undone, or woken). */
export function removeSnooze(state: SnoozeState, account: string, key: string): SnoozeState {
  const snoozed = state.snoozed.filter((r) => !(r.account === account && r.key === key));
  return snoozed.length === state.snoozed.length ? state : { ...state, snoozed };
}

/** Forget one account's snoozes and woken places (by address, case-insensitively). */
export function forgetAccountSnoozes(state: SnoozeState, address: string): SnoozeState {
  const gone = address.trim().toLowerCase();
  if (!gone) return state;
  const other = (account: string) => account.trim().toLowerCase() !== gone;
  const snoozed = state.snoozed.filter((r) => other(r.account));
  const woke = state.woke.filter((r) => other(r.account));
  if (snoozed.length === state.snoozed.length && woke.length === state.woke.length) return state;
  return { snoozed, woke };
}

/** This account's snoozes, by message. */
export function snoozedById(state: SnoozeState, account: string): Map<GmailId, SnoozeRecord> {
  const out = new Map<GmailId, SnoozeRecord>();
  for (const record of state.snoozed) {
    if (record.account !== account) continue;
    for (const id of record.gmailIds) out.set(id, record);
  }
  return out;
}

/** This account's snoozes whose time has come. */
export function dueSnoozes(state: SnoozeState, account: string, now: Millis): SnoozeRecord[] {
  return state.snoozed.filter((r) => r.account === account && r.wakeAt <= now);
}

/**
 * Snoozes a new message has woken early: a message in the conversation, in the Inbox,
 * that was not one of those snoozed and arrived after the snooze. Gmail does the same,
 * since a reply is exactly what the snooze was waiting for.
 */
export function repliedSnoozes(
  state: SnoozeState,
  account: string,
  all: readonly Email[],
  now: Millis,
): SnoozeRecord[] {
  const out: SnoozeRecord[] = [];
  for (const record of state.snoozed) {
    if (record.account !== account || now - record.snoozedAt < EARLY_WAKE_GRACE_MS) continue;
    const ids = new Set(record.gmailIds);
    const replied = all.some(
      (email) =>
        email.mailbox === "inbox" &&
        !ids.has(email.gmailId) &&
        email.receivedAt > record.snoozedAt &&
        snoozeKeyFor(email) === record.key,
    );
    if (replied) out.push(record);
  }
  return out;
}

/**
 * Snoozes whose messages have all gone to the Trash or Spam (from another client):
 * nothing to wake. Only judged on messages the cache knows; one it does not know yet
 * keeps the record.
 */
export function abandonedSnoozes(state: SnoozeState, account: string, all: readonly Email[]): SnoozeRecord[] {
  const byId = new Map(all.map((email) => [email.gmailId, email]));
  return state.snoozed.filter((record) => {
    if (record.account !== account) return false;
    return record.gmailIds.every((id) => {
      const email = byId.get(id);
      return email !== undefined && (email.mailbox === "trash" || email.mailbox === "spam");
    });
  });
}

/** Note messages as woken at `at`. */
export function markWoke(state: SnoozeState, account: string, gmailIds: readonly GmailId[], at: Millis): SnoozeState {
  const ids = new Set(gmailIds);
  const kept = state.woke.filter((entry) => !(entry.account === account && ids.has(entry.gmailId)));
  return { ...state, woke: [...kept, ...gmailIds.map((gmailId) => ({ gmailId, account, wokeAt: at }))] };
}

/**
 * Drop woken places that no longer matter: older than `WOKE_TTL_MS`, or a message (that
 * the cache knows) which has left the Inbox since. The same object back when nothing
 * changed.
 */
export function pruneWoke(state: SnoozeState, all: readonly Email[], now: Millis): SnoozeState {
  const byId = new Map(all.map((email) => [email.gmailId, email]));
  const woke = state.woke.filter((entry) => {
    if (now - entry.wokeAt > WOKE_TTL_MS) return false;
    const email = byId.get(entry.gmailId);
    return email === undefined || email.mailbox === "inbox";
  });
  return woke.length === state.woke.length ? state : { ...state, woke };
}

/**
 * Lays the snoozes over a reading of the mailbox, so every reading agrees with them: a
 * snoozed message is out of the Inbox (archived, as Gmail has it once the label call
 * lands), and a woken one in the Inbox is dated by its wake time, so it sorts at the top
 * and the row says when it came back.
 *
 * Memoised per message object, so the same message gives the same copy every time and
 * the store's per-object caches keep working; the array comes back unchanged (the same
 * object) when nothing applies.
 */
export class SnoozeOverlay {
  private cache = new WeakMap<Email, { sig: string; out: Email }>();

  apply(emails: readonly Email[], state: SnoozeState, account: string): Email[] {
    const snoozed = snoozedById(state, account);
    const woke = new Map<GmailId, Millis>();
    for (const entry of state.woke) if (entry.account === account) woke.set(entry.gmailId, entry.wokeAt);
    if (snoozed.size === 0 && woke.size === 0) return emails as Email[];
    let changed = false;
    const out = emails.map((email) => {
      let sig = "";
      if (email.mailbox === "inbox" && snoozed.has(email.gmailId)) sig = "s";
      else if (email.mailbox === "inbox" && (woke.get(email.gmailId) ?? 0) > email.receivedAt) {
        sig = `w${woke.get(email.gmailId)}`;
      }
      if (!sig) return email;
      const hit = this.cache.get(email);
      if (hit && hit.sig === sig) {
        changed = true;
        return hit.out;
      }
      const next: Email =
        sig === "s" ? { ...email, mailbox: "archive" } : { ...email, receivedAt: woke.get(email.gmailId)! };
      this.cache.set(email, { sig, out: next });
      changed = true;
      return next;
    });
    return changed ? out : (emails as Email[]);
  }
}

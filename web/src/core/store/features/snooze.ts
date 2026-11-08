/**
 * Snooze: holding mail on this device and bringing it back.
 *
 * A snooze is a device record with a wake time, laid over the mailboxes by
 * `SnoozeOverlay`. The records live in their own storage slot, shared with the
 * other windows of the app, so every save merges against what was read last
 * (STRM-290) instead of clobbering a sibling window's work.
 */

import {
  LATE_WAKE_MS,
  WAKE_FLASH_MS,
  type StoreState,
} from "../state";
import type { Email, Mailbox } from "../../model/email";
import {
  abandonedSnoozes,
  addSnooze,
  dueSnoozes,
  markWoke,
  mergeSnoozes,
  parseSnoozes,
  pruneWoke,
  repliedSnoozes,
  removeSnooze,
  snoozeKeyFor,
  snoozedById,
  type SnoozeRecord,
  type SnoozeState,
} from "../../mail/snooze";
import { formatWhen } from "../../mail/when";
import type { WinnowStore } from "../store";

/** This account's snoozes, by Gmail id. */
export function snoozedMap(store: WinnowStore): Map<string, SnoozeRecord> {
  const account = store.accountKey();
  const cached = store.snoozedCache;
  if (cached && cached.snoozes === store.state.snoozes && cached.account === account) return cached.map;
  const map = snoozedById(store.state.snoozes, account);
  store.snoozedCache = { snoozes: store.state.snoozes, account, map };
  return map;
}

/** The Snoozed view: the archived messages this device is holding, each with its wake time. */
export function snoozedRows(store: WinnowStore, visible: readonly Email[]): Email[] {
  const map = snoozedMap(store);
  if (map.size === 0) return [];
  const rows: Email[] = [];
  for (const email of visible) {
    const record = email.mailbox === "archive" ? map.get(email.gmailId) : undefined;
    if (!record) continue;
    let row = store.snoozedRowCache.get(email);
    if (!row || row.snoozedUntil !== record.wakeAt) {
      row = { ...email, snoozedUntil: record.wakeAt };
      store.snoozedRowCache.set(email, row);
    }
    rows.push(row);
  }
  return rows;
}

export function saveSnoozes(store: WinnowStore, snoozes: SnoozeState, extra: Partial<StoreState> = {}): void {
  store.set({ snoozes: writeSnoozes(store, snoozes), ...extra });
}

/**
 * Write snoozes, merged first with what storage holds now: another window of the app
 * may have saved its own since this one read (STRM-290). Returns what was kept. The base
 * moves only when the write took, so a change storage refused is still this window's
 * own (added, not removed) at the next save.
 */
export function writeSnoozes(store: WinnowStore, snoozes: SnoozeState): SnoozeState {
  const raw = store.snoozeSlot.read();
  const merged = raw === null ? snoozes : mergeSnoozes(store.snoozeBase, snoozes, parseSnoozes(raw));
  if (store.snoozeSlot.write(merged)) store.snoozeBase = merged;
  return merged;
}

/** Take in what another window wrote to the snooze records. */
export function syncSnoozesFromStorage(store: WinnowStore): void {
  const raw = store.snoozeSlot.read();
  if (raw === null) return;
  const theirs = parseSnoozes(raw);
  const snoozes = mergeSnoozes(store.snoozeBase, store.state.snoozes, theirs);
  store.snoozeBase = theirs;
  if (JSON.stringify(snoozes) !== JSON.stringify(store.state.snoozes)) store.set({ snoozes });
}

/** Whether a message is snoozed on this device for the current account. */
export function isSnoozed(store: WinnowStore, gmailId: string): boolean {
  return snoozedMap(store).has(gmailId);
}

/** The snooze holding a message, for the reader's "Snoozed until …". */
export function snoozeFor(store: WinnowStore, gmailId: string): SnoozeRecord | null {
  return snoozedMap(store).get(gmailId) ?? null;
}

/**
 * Snooze the conversations of `ids` until `wakeAt`: each conversation's Inbox messages
 * leave the Inbox now (archived, with the `Winnow/Snoozed` label) and come back at the
 * time, unread, at the top. From the Inbox, the Archive, or Snoozed (a new time). One
 * Undo for all of them, in the status pill. Returns how many conversations it snoozed.
 */
export function snooze(
  store: WinnowStore,
  ids: Iterable<number>,
  wakeAt: number,
  { undo = true }: { undo?: boolean } = {},
): number {
  const account = store.accountKey();
  if (!account) return 0;
  const now = store.now();
  const map = snoozedMap(store);
  const records = new Map<string, SnoozeRecord>();
  const moved: { email: Email; from: Mailbox }[] = [];
  for (const id of new Set(ids)) {
    const email = store.state.all.find((candidate) => candidate.id === id);
    if (!email || (email.mailbox !== "inbox" && email.mailbox !== "archive")) continue;
    const key = snoozeKeyFor(email);
    if (records.has(key)) continue;
    const previous = map.get(email.gmailId);
    const members = store.state.all.filter(
      (other) =>
        other.id === email.id ||
        (email.threadId !== undefined && other.threadId === email.threadId && other.mailbox === "inbox") ||
        (previous !== undefined && previous.gmailIds.includes(other.gmailId)),
    );
    const gmailIds = [...new Set([...members.map((m) => m.gmailId), ...(previous?.gmailIds ?? [])])];
    records.set(key, {
      key,
      account,
      gmailIds,
      wakeAt,
      snoozedAt: now,
      from: previous?.from ?? email.mailbox,
      subject: email.subject,
    });
    for (const member of members) moved.push({ email: member, from: previous ? previous.from : member.mailbox });
  }
  if (records.size === 0) return 0;
  let snoozes = store.state.snoozes;
  for (const record of records.values()) snoozes = addSnooze(snoozes, record);
  saveSnoozes(store, snoozes);
  for (const { email } of moved) snoozeInGmail(store, email);
  const backend = store.backend;
  const keys = [...records.keys()];
  if (!undo) return records.size;
  store.offerUndo(`Snoozed until ${formatWhen(wakeAt, now)}.`, () => {
    if (store.backend !== backend) return;
    releaseSnoozes(store, keys, { restore: new Map(moved.map((m) => [m.email.gmailId, m])) });
  });
  return records.size;
}

/** One message into its snooze: out of the Inbox now, labelled in Gmail. */
function snoozeInGmail(store: WinnowStore, email: Email): void {
  const backend = store.backend;
  const label = async () => {
    if (!backend) return;
    if (backend.setSnoozed) {
      try {
        await backend.setSnoozed(email.gmailId, true);
        return;
      } catch {
        // No label (offline, or Gmail refused it): archiving is the part that matters,
        // and the offline queue carries that one.
      }
    }
    if (email.mailbox === "inbox") await backend.moveToMailbox(email.id, "archive");
  };
  if (email.mailbox !== "inbox") {
    void label().catch(() => undefined);
    return;
  }
  store.mutate(
    email.id,
    () => ({ ...email, mailbox: "archive" }),
    async () => {
      try {
        await label();
      } catch (error) {
        // Gmail refused even the archive: the snooze did not happen, so the record goes
        // before the rollback puts the message back.
        forgetSnoozed(store, [email.gmailId]);
        throw error;
      }
    },
    { previousMailbox: "inbox", previousUnread: email.unread },
  );
}

/** Drop messages from their snoozes, without moving anything. */
export function forgetSnoozed(store: WinnowStore, gmailIds: readonly string[]): void {
  const ids = new Set(gmailIds);
  const account = store.accountKey();
  let changed = false;
  const snoozed = store.state.snoozes.snoozed
    .map((record) => {
      if (record.account !== account || !record.gmailIds.some((id) => ids.has(id))) return record;
      changed = true;
      return { ...record, gmailIds: record.gmailIds.filter((id) => !ids.has(id)) };
    })
    .filter((record) => record.gmailIds.length > 0);
  if (changed) saveSnoozes(store, { ...store.state.snoozes, snoozed });
}

/**
 * Bring snoozed conversations back. Woken (`wake`): to the Inbox, unread, placed at
 * `wokeAt`. Unsnoozed by hand: to the Inbox at the top, read state kept. Undone
 * (`restore`): back where each message was, read state as it was, label off.
 */
export function releaseSnoozes(
  store: WinnowStore,
  keys: readonly string[],
  how: { wake?: Map<string, number>; restore?: Map<string, { email: Email; from: Mailbox }> } = {},
): string[] {
  const account = store.accountKey();
  const now = store.now();
  const records = store.state.snoozes.snoozed.filter((r) => r.account === account && keys.includes(r.key));
  if (records.length === 0) return [];
  let snoozes = store.state.snoozes;
  for (const record of records) snoozes = removeSnooze(snoozes, account, record.key);
  const woken: string[] = [];
  const placed = new Map<string, number>();
  for (const record of records) {
    for (const gmailId of record.gmailIds) {
      const restore = how.restore?.get(gmailId);
      if (restore && restore.from !== "inbox") continue;
      woken.push(gmailId);
      placed.set(gmailId, how.wake?.get(record.key) ?? now);
    }
  }
  if (!how.restore) {
    for (const [gmailId, at] of placed) snoozes = markWoke(snoozes, account, [gmailId], at);
  }
  const ids = new Set(records.flatMap((r) => r.gmailIds));
  const recent = how.wake
    ? new Set([...store.state.recentIds, ...store.state.all.filter((e) => ids.has(e.gmailId)).map((e) => e.id)])
    : store.state.recentIds;
  saveSnoozes(store, snoozes, { recentIds: recent });

  const backend = store.backend;
  for (const gmailId of ids) {
    const restore = how.restore?.get(gmailId);
    const toInbox = !restore || restore.from === "inbox";
    const unread = how.wake ? true : restore ? restore.email.unread : undefined;
    const email = store.state.all.find((candidate) => candidate.gmailId === gmailId);
    const call = async () => {
      if (!backend) return;
      if (backend.setSnoozed) {
        try {
          await backend.setSnoozed(gmailId, false, { unread: unread === true, toInbox });
          return;
        } catch {
          // Fall back to the plain move (queued when offline); the label may stay.
        }
      }
      if (!email) return;
      if (toInbox) await backend.moveToMailbox(email.id, "inbox");
      if (unread === true) await backend.setRead(email.id, false);
    };
    if (!email) {
      void call().catch(() => undefined);
      continue;
    }
    if (!toInbox) {
      void call().catch(() => undefined);
      continue;
    }
    store.mutate(
      email.id,
      () => ({ ...email, mailbox: "inbox", unread: unread ?? email.unread }),
      call,
      { previousMailbox: email.mailbox, previousUnread: email.unread },
    );
  }
  return woken;
}

/**
 * Unsnooze by hand (the Snoozed view's Unsnooze): the conversations of `ids` go back to
 * the Inbox now, at the top, with Undo (which snoozes them again until the same time).
 */
export function unsnooze(store: WinnowStore, ids: Iterable<number>): number {
  const map = snoozedMap(store);
  const records = new Map<string, SnoozeRecord>();
  for (const id of ids) {
    const email = store.state.all.find((candidate) => candidate.id === id);
    const record = email ? map.get(email.gmailId) : undefined;
    if (record) records.set(record.key, record);
  }
  if (records.size === 0) return 0;
  const taken = [...records.values()];
  releaseSnoozes(store, [...records.keys()]);
  const backend = store.backend;
  store.offerUndo(taken.length === 1 ? "Unsnoozed." : `Unsnoozed ${taken.length}.`, () => {
    if (store.backend !== backend) return;
    for (const record of taken) {
      const targets = store.state.all.filter((email) => record.gmailIds.includes(email.gmailId)).map((e) => e.id);
      snooze(store, targets, record.wakeAt, { undo: false });
    }
  });
  return records.size;
}

/**
 * Wake whatever is due: snoozes whose time has passed (late if the app was closed then)
 * and conversations a new message has woken early; drop snoozes whose mail went to the
 * Trash elsewhere, and woken places that no longer matter. Run on start, after every
 * sync, on focus and on the app's timer. Returns how many conversations woke.
 */
export function wakeDue(store: WinnowStore): number {
  const account = store.accountKey();
  if (!account) return 0;
  const now = store.now();
  const all = store.state.all;
  let snoozes = store.state.snoozes;
  for (const record of abandonedSnoozes(snoozes, account, all)) snoozes = removeSnooze(snoozes, account, record.key);
  snoozes = pruneWoke(snoozes, all, now);
  const due = new Map<string, SnoozeRecord>();
  for (const record of dueSnoozes(snoozes, account, now)) due.set(record.key, record);
  const replied = repliedSnoozes(snoozes, account, all, now).filter((record) => !due.has(record.key));
  if (snoozes !== store.state.snoozes) saveSnoozes(store, snoozes);
  if (due.size === 0 && replied.length === 0) return 0;
  // Placed at the moment it came back: the chosen time when Winnow was open then, the
  // next open when it was closed (so a late wake still lands at the top, not below the
  // mail that arrived while it was away).
  const wake = new Map<string, number>();
  for (const record of due.values()) wake.set(record.key, now);
  for (const record of replied) wake.set(record.key, now);
  releaseSnoozes(store, [...wake.keys()], { wake });
  const count = wake.size;
  const late = [...due.values()].filter((record) => now - record.wakeAt > LATE_WAKE_MS);
  const text =
    count === 1 ? "A snoozed conversation is back in your Inbox." : `${count} snoozed conversations are back in your Inbox.`;
  store.flash(
    late.length > 0
      ? `${text} It was due ${formatWhen(Math.min(...late.map((r) => r.wakeAt)), now)}, while Winnow was closed.`
      : text,
    WAKE_FLASH_MS,
  );
  return count;
}

export type { MailboxView } from "../state";

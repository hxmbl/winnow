/**
 * Send later: the records behind every scheduled send.
 *
 * A set of records, like snoozes: written into their own storage slot, merged
 * against what this window last read, so two windows of the app cannot lose each
 * other's schedules (STRM-290). Sending itself lives in the sync feature; this
 * module owns the list, its Scheduled-view rows, and the claim that stops a
 * second window sending the same message.
 */

import type { Email, Mailbox } from "../../model/email";
import {
  addSchedule,
  mergeSchedules,
  parseSchedules,
  removeSchedule,
  scheduleVerdict,
  scheduledRow,
  serializeSchedules,
  updateSchedule,
  type ScheduledSend,
} from "../../mail/scheduledSend";
import { CLAIM_HOLD_MS } from "../state";
import { DEMO_ACCOUNT } from "../../data/demo";
import type { WinnowStore } from "../store";

/** The Scheduled view's rows, one per send of this account. */
export function scheduledRows(store: WinnowStore): Email[] {
  const account = store.accountKey();
  const self = store.state.account?.email ?? DEMO_ACCOUNT.email;
  const cached = store.scheduledCache;
  if (cached && cached.sends === store.state.scheduled && cached.account === account && cached.self === self)
    return cached.rows;
  const rows = store.state.scheduled
    .filter((send) => send.account === account)
    .map((send) => scheduledRow(send, { email: self, name: store.backend ? undefined : DEMO_ACCOUNT.name }));
  store.scheduledCache = { sends: store.state.scheduled, account, self, rows };
  return rows;
}

/** This account's scheduled sends, soonest first. */
export function scheduledSends(store: WinnowStore): ScheduledSend[] {
  const account = store.accountKey();
  return store.state.scheduled.filter((send) => send.account === account);
}

/** The scheduled send behind a Scheduled row (by row id), or by its own id. */
export function scheduledSend(store: WinnowStore, idOrRow: string | number): ScheduledSend | null {
  if (typeof idOrRow === "string") return store.state.scheduled.find((send) => send.id === idOrRow) ?? null;
  const row = scheduledRows(store).find((email) => email.id === idOrRow);
  return row?.scheduled ? (store.state.scheduled.find((send) => send.id === row.scheduled!.id) ?? null) : null;
}

/** `false` when storage refused the write: the change then holds for this run only. */
export function saveSchedules(store: WinnowStore, scheduled: ScheduledSend[]): boolean {
  const { kept, stored } = writeSchedules(store, scheduled);
  showSchedules(store, kept);
  return stored;
}

/** Sends, written the same way as the snoozes: merged with what storage holds now. */
export function writeSchedules(
  store: WinnowStore,
  scheduled: readonly ScheduledSend[],
): { kept: ScheduledSend[]; stored: boolean } {
  const raw = store.scheduleSlot.read();
  const kept = raw === null ? [...scheduled] : mergeSchedules(store.scheduleBase, scheduled, parseSchedules(raw));
  const stored = store.scheduleSlot.write(serializeSchedules(kept));
  if (stored) store.scheduleBase = parseSchedules(serializeSchedules(kept));
  return { kept, stored };
}

/** Take in what another window wrote to the send-later records. */
export function syncSchedulesFromStorage(store: WinnowStore): void {
  const raw = store.scheduleSlot.read();
  if (raw === null) return;
  const theirs = parseSchedules(raw);
  const scheduled = mergeSchedules(store.scheduleBase, store.state.scheduled, theirs);
  store.scheduleBase = theirs;
  const same = JSON.stringify(serializeSchedules(scheduled)) === JSON.stringify(serializeSchedules(store.state.scheduled));
  if (!same) showSchedules(store, scheduled);
}

/** Put sends in state, letting go of an open Scheduled row whose send is gone. */
export function showSchedules(store: WinnowStore, scheduled: ScheduledSend[]): void {
  const selectedGone =
    store.state.mailbox === "scheduled" &&
    store.state.selectedId !== null &&
    !scheduled.some((send) => scheduledRow(send, { email: "" }).id === store.state.selectedId);
  store.set({ scheduled, ...(selectedGone ? { selectedId: null } : {}) });
}

/**
 * Record a message to send later (replacing an earlier time for the same draft).
 * `false` when storage refused it: it is scheduled for this run only, so the caller
 * keeps the draft's device copy rather than leave the message only in memory.
 */
export function scheduleSend(store: WinnowStore, send: ScheduledSend): boolean {
  return saveSchedules(store, addSchedule(store.state.scheduled, send));
}

/** Cancel a schedule; the draft stays a draft. Returns what was cancelled. */
export function cancelSchedule(store: WinnowStore, id: string): ScheduledSend | null {
  const send = scheduledSend(store, id);
  if (!send) return null;
  saveSchedules(store, removeSchedule(store.state.scheduled, id));
  return send;
}

export function updateScheduled(
  store: WinnowStore,
  id: string,
  patch: Partial<Pick<ScheduledSend, "claimedAt" | "problem" | "sendAt" | "draftId">>,
): void {
  if (!store.state.scheduled.some((send) => send.id === id)) return;
  saveSchedules(store, updateSchedule(store.state.scheduled, id, patch));
}

/**
 * The send `id`, if it may go out now, checked right before it is dispatched (the
 * Send-later runner and Send now both ask): only a send listed under the open account,
 * and only while every account it names is still signed in here. One whose account is
 * gone is dropped here, never sent from another (`scheduleVerdict`).
 */
export function permitScheduled(store: WinnowStore, id: string): ScheduledSend | null {
  const send = store.state.scheduled.find((candidate) => candidate.id === id);
  if (!send) return null;
  const verdict = scheduleVerdict(send, {
    account: store.accountKey(),
    openId: store.state.accountId,
    accounts: store.state.accounts.filter((account) => !account.demo),
  });
  if (verdict === "drop") saveSchedules(store, removeSchedule(store.state.scheduled, id));
  return verdict === "send" ? send : null;
}

/**
 * Claim a due send for this window, so a second window of the app does not send it
 * too: read what storage says now (another window may have claimed it a moment ago),
 * and write the claim. `false` when someone else holds it.
 */
export function claimScheduled(store: WinnowStore, id: string, now: number = store.now()): boolean {
  const raw = store.scheduleSlot.read();
  const stored = raw === null ? undefined : parseSchedules(raw).find((send) => send.id === id);
  // Stored once and gone now: another window sent or cancelled it since this one read.
  if (raw !== null && !stored && store.scheduleBase.some((send) => send.id === id)) {
    store.syncDeviceRecords();
    return false;
  }
  if (stored?.claimedAt !== undefined && now - stored.claimedAt <= CLAIM_HOLD_MS) return false;
  updateScheduled(store, id, { claimedAt: now });
  return true;
}

export type { Mailbox };

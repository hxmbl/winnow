/**
 * Notification delivery and cleanup.
 *
 * The store remains the coordinator: it calls these functions as mailbox state changes,
 * sync discovers new mail, or the platform reports background notifications.
 */

import type { Email } from "../../model/email";
import { debugLog } from "../../debug/debugLog";
import { draftForKeptReply, notifiable, staleNotices, type KeptReply } from "../../notify/notifications";
import type { WinnowStore } from "../store";

function watchNotices(store: WinnowStore, gmailIds: Iterable<string>, account: string | null = store.state.accountId): void {
  const key = account ?? "";
  const set = store.noticeWatch.get(key) ?? new Set<string>();
  for (const id of gmailIds) set.add(id);
  while (set.size > 500) set.delete(set.values().next().value as string);
  store.noticeWatch.set(key, set);
}

/** Dismiss notices whose mail has already been dealt with. */
export function reconcileNotices(store: WinnowStore): void {
  if (!store.backend || !store.platform?.withdrawNotifications) return;
  const watched = store.noticeWatch.get(store.state.accountId ?? "");
  if (!watched || watched.size === 0) return;
  const stale = staleNotices(watched, store.state.all);
  if (stale.length === 0) return;
  for (const id of stale) watched.delete(id);
  debugLog("notify", "dismissed", { messages: stale.length });
  void store.platform.withdrawNotifications(stale).catch(() => undefined);
}

/** Adopt notifications posted by a background platform service while the app was closed. */
export async function adoptNotifications(store: WinnowStore): Promise<void> {
  if (!store.platform?.activeNotifications) return;
  const active = await store.platform.activeNotifications().catch(() => []);
  for (const { account, gmailId } of active) watchNotices(store, [gmailId], account);
  reconcileNotices(store);
}

/** Announce genuinely new mail, if the user asked for notifications. */
export async function notifyIfNew(store: WinnowStore, recent: ReadonlySet<number>): Promise<void> {
  if (!store.state.preferences.notificationsEnabled || !store.platform || recent.size === 0) return;
  const arrived = notifiable(
    store.state.all.filter((email) => recent.has(email.id)),
    store.state.preferences,
  );
  if (arrived.length === 0) return;
  watchNotices(store, arrived.map((email) => email.gmailId));
  await store.platform.notifyNewMail(arrived).catch(() => undefined);
}

/** Fetch the reply headers for a notification batch. Failure never blocks the notification. */
export async function notificationReplyHeads(store: WinnowStore, emails: readonly Email[]): Promise<Record<string, string>> {
  if (!store.backend?.replyHeads || !store.state.preferences.notificationActions.reply) return {};
  try {
    return await store.backend.replyHeads(emails.map((email) => email.gmailId));
  } catch {
    return {};
  }
}

/** Save replies that a platform notification could not send or retain. */
export async function saveKeptReplies(
  store: WinnowStore,
  kept: readonly KeptReply[],
): Promise<{ saved: number; failed: KeptReply[] }> {
  const drafts = store.backend?.drafts;
  if (!drafts) return { saved: 0, failed: [...kept] };
  let saved = 0;
  const failed: KeptReply[] = [];
  for (const reply of kept) {
    const original = store.state.all.find((email) => email.gmailId === reply.gmailId);
    const draft = draftForKeptReply(reply, original);
    if (!draft) {
      failed.push(reply);
      continue;
    }
    try {
      await drafts.create(draft, original ? original.gmailId : undefined);
      saved += 1;
    } catch {
      failed.push(reply);
    }
  }
  if (saved > 0) void store.refreshDrafts().catch(() => undefined);
  return { saved, failed };
}

/** The OS badge count, excluding unread messages from muted senders. */
export function badgeCount(store: WinnowStore): number {
  if (!store.state.preferences.unreadBadge) return 0;
  const muted = store.state.preferences.mutedSenders;
  if (muted.length === 0) return store.view.unreadCount;
  const keys = new Set(muted.map((sender) => sender.toLowerCase()));
  const blocked = new Set(store.state.preferences.blockedSenders.map((sender) => sender.toLowerCase()));
  const mutedUnread = store.state.all.filter((email) => {
    const sender = email.sender.toLowerCase();
    return email.unread && store.isListed(email) && keys.has(sender) && !blocked.has(sender);
  }).length;
  return Math.max(0, store.view.unreadCount - mutedUnread);
}

/**
 * Wiring new-mail notifications to the running app: what a sync announces, what a
 * press does, and the replies a phone kept while it could not send.
 *
 * Here rather than in `main.tsx` so the pieces are named and testable; `main.tsx`
 * calls `wireNotifications` once the store exists. The decisions themselves are in
 * `core/notify/notifications.ts`.
 */

import type { Email } from "../core/model/email";
import {
  buildNotificationBatch,
  handleNotificationAction,
  parseKeptReply,
  type KeptReply,
} from "../core/notify/notifications";
import type { WinnowStore } from "../core/store/store";
import type { Platform } from "../platform/types";

// ── Reply requests ────────────────────────────────────────────────────────

/**
 * "Open the composer on a reply to the open message." The composer is `App`'s state,
 * so `App` registers the one function that can do that, and a notification's Reply on
 * the desktop asks for it here.
 */
let replyOpener: (() => void) | null = null;

export function onReplyRequest(open: () => void): () => void {
  replyOpener = open;
  return () => {
    if (replyOpener === open) replyOpener = null;
  };
}

function requestReply(): void {
  replyOpener?.();
}

// ── The store's bridge ────────────────────────────────────────────────────

/** `PlatformBridge.notifyNewMail`: the store's arrivals, as the platform's batch. */
export async function announce(store: WinnowStore, platform: Platform, emails: readonly Email[]): Promise<void> {
  if (emails.length === 0) return;
  const preferences = store.getSnapshot().preferences;
  const heads = await store.notificationReplyHeads(emails.slice(0, 5));
  await platform.notifyNewMail(buildNotificationBatch(emails, preferences, heads));
}

// ── Presses and kept replies ──────────────────────────────────────────────

export function wireNotifications(store: WinnowStore, platform: Platform): () => void {
  const unlisten = platform.onNotificationAction((event) => {
    handleNotificationAction(event, {
      focusWindow: () => platform.focusWindow(),
      focusMessage: (id) => store.focusMessage(id),
      openReply: requestReply,
      find: (id) => store.getSnapshot().all.find((email) => email.id === id),
      setRead: (id, read) => store.setRead(id, read),
      trashWithUndo: (id) => store.moveWithUndo(id, "trash"),
      refresh: () => store.refresh(),
      confirm: (id, title, text, failed) => void platform.confirmNotificationAction?.(id, title, text, failed),
    });
    // A failed native action was about a message the user may now want to see.
    if (event.origin === "android" && event.outcome === "failed") {
      store.setNotice("A notification action didn't go through. It's shown on the notification.");
    }
  });
  return unlisten;
}

/**
 * Save any replies the phone kept to Drafts, and release each from the phone only once
 * Gmail has it. One that cannot be saved yet (still offline) stays on the phone for the
 * next try: nothing typed is ever dropped on the way.
 */
export async function saveKeptReplies(store: WinnowStore, platform: Platform): Promise<void> {
  if (!platform.keptReplies || !platform.releaseKeptReplies) return;
  if (store.getSnapshot().status !== "ready") return;
  const raw = await platform.keptReplies().catch(() => []);
  const kept = raw.map(parseKeptReply).filter((reply): reply is KeptReply => reply !== null);
  if (kept.length === 0) return;
  const { saved, failed } = await store.saveKeptReplies(kept);
  const failedIds = new Set(failed.map((reply) => reply.requestId));
  const released = kept.filter((reply) => !failedIds.has(reply.requestId)).map((reply) => reply.requestId);
  if (released.length > 0) await platform.releaseKeptReplies(released).catch(() => undefined);
  if (saved === 0) return;
  store.setNotice(
    saved === 1
      ? "A reply you wrote in a notification couldn't be sent, so it's saved in Drafts."
      : `${saved} replies you wrote in notifications couldn't be sent, so they're saved in Drafts.`,
  );
}

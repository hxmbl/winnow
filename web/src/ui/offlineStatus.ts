/**
 * The "Offline: N changes waiting" line, as a pure function of the queue's status
 * (`core/offline/queue.ts`), so its wording and when it shows are tested without React.
 *
 * Subtle on purpose: it is a fact about the mail, not an error. It shows only while
 * something waits, and says why it waits, because "waiting" alone reads like a hang.
 */

import type { QueueStatus } from "../core/offline/queue";

export function offlineStatusText(status: QueueStatus, online: boolean): string | null {
  const { waiting, state } = status;
  if (waiting === 0) return null;
  const changes = `${waiting} ${waiting === 1 ? "change" : "changes"} waiting`;
  if (state === "auth") return `Sign in again: ${changes}`;
  if (!online || state === "offline") return `Offline: ${changes}`;
  if (state === "backoff") return `Can't reach Gmail: ${changes}`;
  return `Syncing ${changes.replace(" waiting", "")}…`;
}

/** The red bar over a mailbox the last sync couldn't refresh: the local copy, still usable. */
export const CONNECTION_LOST = "Failed to connect to Gmail. Check your connection.";

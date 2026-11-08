/** Backend sync and incremental updates, coordinated through WinnowStore. */
import { debugLog } from "../../debug/debugLog";
import type { Email } from "../../model/email";
import { partitionBodies } from "../helpers/bodies";
import type { WinnowStore } from "../store";

const PROGRESS_NOTIFY_MS = 500;

  export async function runSync(store: WinnowStore, { initial }: { initial: boolean }): Promise<void> {
    const backend = store.backend;
    if (!backend) return;

    store.set({
      ...(initial ? { status: "loading" as const } : {}),
      syncing: true,
      error: null,
      syncPhase: null,
      syncFraction: null,
      syncFetched: 0,
      syncStage: null,
      syncTotal: null,
      syncError: null,
    });
    let lastProgressNotify = 0;
    const started = Date.now();
    debugLog("sync", "start", { initial, cached: store.state.all.length });

    const known = new Set(store.state.all.map((email) => email.gmailId));

    try {
      const result = await backend.sync({
        // 1.4.0: a sync of an account that has since been left paints nothing.
        onPartial: (emails) => {
          if (store.backend === backend) store.applyPartial(emails, initial);
        },
        onProgress: (progress) => {
          if (store.backend !== backend) return;
          // Progress arrives on the engine's schedule, so it is written to state
          // *without* notifying: a first sync of two thousand messages would otherwise
          // re-render two thousand times to move a percentage. A phase change is
          // notified, being a visible transition rather than a per-message increment.
          const phase = progress.phase === "idle" || progress.phase === "sending"
            ? store.state.syncPhase
            : progress.phase;
          const stage = progress.stage ?? null;
          const changed = store.state.syncPhase !== phase || store.state.syncStage !== stage;
          if (changed) debugLog("sync", "phase", { phase, stage, fetched: progress.fetched, total: progress.total ?? null, ms: Date.now() - started });
          store.state = {
            ...store.state,
            syncing: true,
            syncPhase: phase,
            syncStage: stage,
            syncTotal: progress.total ?? null,
            syncFraction: progress.fraction,
            syncFetched: progress.fetched,
          };
          // The count on the status line ("Syncing inbox, 340 of 1,200") is worth a
          // re-render twice a second, not once per message.
          const now = Date.now();
          if (changed || now - lastProgressNotify >= PROGRESS_NOTIFY_MS) {
            lastProgressNotify = now;
            store.notify();
          }
        },
      });

      // Another account opened (or the app signed out) while this ran: its answer is
      // not this screen's.
      if (store.backend !== backend) return;
      const recent = new Set<number>();
      if (!initial) {
        for (const email of result.emails) {
          if (!known.has(email.gmailId)) recent.add(email.id);
        }
      }

      const { emails, bodies, checked } = partitionBodies(result.emails);
      // Replaced wholesale rather than merged: a sync is a fresh reading, and a body
      // resident for a message that has since left is memory nobody is using. Bodies
      // loaded *during* the sync are in the cache, so they are in `result.emails` too.
      store.bodies = bodies;
      store.bodyChecked = checked;
      store.bodyFailed = new Set();

      store.set({
        status: "ready",
        all: emails,
        syncing: false,
        syncPhase: null,
        syncStage: null,
        syncTotal: null,
        syncFraction: null,
        syncError: null,
        connectionLost: false,
        syncFailed: result.failed,
        lastSyncedAt: Date.now(),
        recentIds: recent,
        truncated: result.truncated,
        notice: syncNotice(result),
        storagePrompt: result.cacheUnpersisted
          ? store.storageDeclined
            ? null
            : store.state.storagePrompt === "failed"
              ? "failed"
              : "ask"
          : null,
        error: result.failed > 0 ? syncFailureSummary(result.failed) : null,
      });

      store.accountMail = true;
      debugLog("sync", "done", {
        initial,
        ms: Date.now() - started,
        messages: result.emails.length,
        new: recent.size,
        failed: result.failed,
        truncated: Boolean(result.truncated),
        cacheUnpersisted: Boolean(result.cacheUnpersisted),
      });
      if (!initial) await store.notifyIfNew(recent);
      // Notifications posted while the app was away (Android's background service) whose
      // mail this sync shows dealt with go now.
      void store.adoptNotifications();
      // Mail that was here and is gone (deleted on the server, found by history or the
      // daily reconciliation) takes its notification with it.
      const present = new Set(result.emails.map((email) => email.gmailId));
      const vanished = [...known].filter((gmailId) => !present.has(gmailId));
      if (vanished.length > 0) {
        debugLog("sync", "removed", { messages: vanished.length });
        void store.platform?.withdrawNotifications?.(vanished).catch(() => undefined);
      }
      await store.applyPlatform();
      store.prefetchInbox();
      store.afterSyncOffline(backend, Boolean(result.cacheUnpersisted));
    } catch (error) {
      if (store.backend !== backend) return;
      debugLog("sync", "failed", {
        initial,
        ms: Date.now() - started,
        kind: error instanceof Error ? ((error as { kind?: unknown }).kind as string | undefined) ?? error.name : typeof error,
        status: typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : undefined,
        online: globalThis.navigator?.onLine,
        reason: error instanceof Error ? error.message : "unknown",
      });
      const message = error instanceof Error ? error.message : "Could not reach Gmail.";
      if (store.accountMail && store.state.all.length > 0 && !accountProblem(error)) {
        // Mail is on screen and nothing is wrong with the account: keep the local copy
        // usable instead of swapping the whole inbox for an error screen. The poll tries
        // again on its own; the first sync that gets through clears the bar.
        store.set({
          status: "ready",
          syncing: false,
          syncPhase: null,
          syncStage: null,
          syncTotal: null,
          syncError: message,
          connectionLost: true,
          error: null,
        });
        store.pendingConnect = null;
        return;
      }
      store.set({
        status: "error",
        syncing: false,
        syncPhase: null,
        syncStage: null,
        syncTotal: null,
        syncError: message,
        error: message,
      });
      throw error;
    }
  }

  export function applyPartial(store: WinnowStore, emails: Email[], initial: boolean): void {
    if (!store.backend || !store.state.syncing) return;
    const partition = partitionBodies(emails);
    for (const [id, html] of partition.bodies) store.bodies.set(id, html);
    for (const id of partition.checked) store.bodyChecked.add(id);
    store.set({
      all: partition.emails,
      ...(initial && store.state.status === "loading" ? { status: "ready" as const } : {}),
    });
  }

/** The message shown when a sync could not download everything. */
export function syncFailureSummary(count: number): string {
  return `${count} message${count === 1 ? "" : "s"} failed to download this sync — refresh to retry.`;
}

/**
 * The non-blocking half of a sync's outcome.
 *
 * A truncated view is not an error: the sync worked, the user just has more mail than
 * Winnow will walk. It went into `error` before, the wrong channel — an error banner is
 * dismissible and alarming, and "only some of your archive is here" is a permanent
 * property of the account, not something retry resolves.
 *
 * A cache that could not be persisted used to be a note here too. It is now a
 * question (`storagePrompt`), because the user's answer changes what happens next.
 */
export function syncNotice(result: { truncated: boolean; cacheUnpersisted?: boolean }): string | null {
  const notes: string[] = [];
  if (result.truncated) {
    notes.push("Some mailboxes hold more than Winnow will walk, so older messages are not listed.");
  }
  // `cacheUnpersisted` is not a note any more: it is a question with two answers, and
  // lives in `storagePrompt` (see `STORAGE_PROMPT`).
  return notes.length > 0 ? notes.join(" ") : null;
}

/**
 * A sync failure that means the account itself needs attention, as opposed to Gmail
 * being out of reach. Only these keep the blocking "Couldn't reach Gmail" screen when
 * there is cached mail to show: a session that has to be signed in again, a build or
 * client Google rejects, or a request Google answered with 401 or 403.
 */
export function accountProblem(error: unknown): boolean {
  const { kind, status } = (error ?? {}) as { kind?: unknown; status?: unknown };
  if (kind === "reauth_required" || kind === "config" || kind === "invalid_client") return true;
  return status === 401 || status === 403;
}

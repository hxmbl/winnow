/**
 * What the sync line and the sync button say.
 *
 * One pure function so the two can never disagree with each other or with the
 * store: a syncing label only while `syncing` is true, and an idle label only while
 * it is false. Every state says exactly what is happening, in words:
 *
 *   - syncing   — "Syncing inbox, 340 of 1,200", "Syncing other folders",
 *                 "Syncing changes, 3 of 5", or "Syncing…" when no count is known yet;
 *   - sending   — "Sending…" (a reply on its way, with no sync running);
 *   - failed    — "Couldn't sync: <reason>." / "12 messages failed to download";
 *   - offline   — "Offline: last synced 10:42";
 *   - paused    — "Sync paused: last synced 3 min ago" (automatic sync is off);
 *   - idle      — "Synced just now", "Synced 3 min ago".
 *
 * The button's visible text is also its `aria-label` and tooltip, so a screen reader
 * and a hover say what the eye sees.
 */

export type SyncStatusInput = {
  /** False in the demo. */
  signedIn: boolean;
  syncing: boolean;
  syncPhase: "full" | "incremental" | null;
  syncStage: "inbox" | "other" | null;
  syncFetched: number;
  syncTotal: number | null;
  lastSyncedAt: number | null;
  /** The last sync threw, with this message. */
  syncError: string | null;
  /** The last sync finished, but this many messages could not be downloaded. */
  syncFailed: number;
  /** A reply is on its way. */
  sending: boolean;
  online: boolean;
  /** Automatic sync is switched off. */
  paused: boolean;
  now: number;
  /** Formats a wall-clock time for the offline line; injectable for tests. */
  clock?: (ms: number) => string;
};

export type SyncStatus = {
  /** The status line. */
  line: string;
  /** The button's text, aria-label and tooltip. */
  button: string;
  /** The button is disabled (a sync is already running). */
  busy: boolean;
  tone: "idle" | "busy" | "warning" | "error";
};

const count = new Intl.NumberFormat("en-GB");

/** "just now", "1 min ago", "3 min ago", "2 hr ago", "4 days ago". */
export function syncedAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const defaultClock = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** A reason as a clause: no trailing full stop, so it can be followed by one. */
function clause(reason: string): string {
  return reason.trim().replace(/[.\s]+$/, "") || "unknown error";
}

export function syncStatus(input: SyncStatusInput): SyncStatus {
  if (!input.signedIn) {
    return { line: "Demo mailbox. Nothing leaves this device.", button: "Connect Gmail", busy: false, tone: "idle" };
  }

  if (input.syncing) {
    return { line: syncingLine(input), button: "Syncing…", busy: true, tone: "busy" };
  }

  if (input.sending) {
    return { line: "Sending…", button: "Sync now", busy: false, tone: "busy" };
  }

  if (!input.online) {
    const when = input.lastSyncedAt === null ? "not synced yet" : `last synced ${(input.clock ?? defaultClock)(input.lastSyncedAt)}`;
    return { line: `Offline: ${when}`, button: "Retry", busy: false, tone: "warning" };
  }

  if (input.syncError !== null) {
    return { line: `Couldn't sync: ${clause(input.syncError)}.`, button: "Retry", busy: false, tone: "error" };
  }

  if (input.syncFailed > 0) {
    const n = input.syncFailed;
    return {
      line: `${count.format(n)} message${n === 1 ? "" : "s"} failed to download`,
      button: "Retry",
      busy: false,
      tone: "warning",
    };
  }

  const ago = input.lastSyncedAt === null ? null : syncedAgo(input.lastSyncedAt, input.now);

  if (input.paused) {
    return {
      line: ago === null ? "Sync paused" : `Sync paused: last synced ${ago}`,
      button: "Sync now",
      busy: false,
      tone: "idle",
    };
  }

  return {
    line: ago === null ? "Not synced yet" : `Synced ${ago}`,
    button: "Sync now",
    busy: false,
    tone: "idle",
  };
}

function syncingLine(input: SyncStatusInput): string {
  const known = input.syncTotal !== null && input.syncTotal > 0;
  const progress = known
    ? `, ${count.format(Math.min(input.syncFetched, input.syncTotal!))} of ${count.format(input.syncTotal!)}`
    : "";
  if (input.syncPhase === "full") {
    if (input.syncStage === "other") return "Syncing other folders";
    if (input.syncStage === "inbox") return known ? `Syncing inbox${progress}` : "Syncing inbox…";
  }
  if (input.syncPhase === "incremental" && known) return `Syncing changes${progress}`;
  return "Syncing…";
}

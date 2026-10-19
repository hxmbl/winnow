/**
 * The status pill: Winnow's one in-app notification surface.
 *
 * The frosted pill that says "Synced just now" after a pull to refresh is also where an
 * action says what it did and offers to take it back: "Moved to Trash. Undo", "Draft
 * discarded. Undo", "Sending in 8s… Undo · Send now", "Draft saved.". One surface, so
 * there is never a strip of notices stacking up over the mail.
 *
 * The rules, pure so they can be tested without a DOM:
 *
 *   - newest wins: of everything that could be shown, the most recent is; an older one
 *     still on offer (a Trash Undo under a "Draft saved." flash) comes back when the
 *     newer one goes, and a tie goes to the one that matters more (a message waiting to
 *     send, then an undo, then a flash, then the sync line);
 *   - an Undo acts on its own action: each kind carries its own handler (the store's
 *     single undo offer, or the waiting send), never "whatever was last";
 *   - when an action notice ends — it expired, was undone, was dismissed — the pill
 *     goes back to the sync status for a beat (`SYNC_RETURN_MS`) and then away.
 */

import { PULL_RESULT_MS } from "./pullRefresh";

export type PillNotice =
  /** A sent message waiting out its undo window. */
  | { kind: "sending"; at: number; deadline: number }
  /** The store's undo offer. */
  | { kind: "undo"; at: number; label: string }
  /** A short word about the last action, gone by itself. */
  | { kind: "flash"; at: number; text: string }
  /** The sync status: a pull's result, or the beat after a notice. */
  | { kind: "sync"; at: number; text: string; ok: boolean };

/** How long the pill shows the sync status after a notice ends: as long as a pull's result. */
export const SYNC_RETURN_MS = PULL_RESULT_MS;

const RANK: Record<PillNotice["kind"], number> = { sending: 3, undo: 2, flash: 1, sync: 0 };

/** What the pill shows now: the newest candidate, a tie going to the higher rank. */
export function currentNotice(candidates: readonly (PillNotice | null | undefined)[]): PillNotice | null {
  let best: PillNotice | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (
      best === null ||
      candidate.at > best.at ||
      (candidate.at === best.at && RANK[candidate.kind] > RANK[best.kind])
    ) {
      best = candidate;
    }
  }
  return best;
}

/** An action notice, as opposed to the sync status the pill rests on. */
export function isAction(notice: PillNotice | null): boolean {
  return notice !== null && notice.kind !== "sync";
}

/**
 * Whether the pill goes back to the sync status: an action notice was showing and now
 * none is. One action replacing another does not; neither does a sync line ending.
 */
export function returnsToSync(previous: PillNotice | null, next: PillNotice | null): boolean {
  return isAction(previous) && !isAction(next);
}

/** A stable identity per notice, so a new one arrives with its own entrance. */
export function noticeKey(notice: PillNotice): string {
  return `${notice.kind}:${notice.at}`;
}

/** "Sending in 8s…", or "Sending…" in the last moment. */
export function sendingText(deadline: number, now: number): string {
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));
  return left > 0 ? `Sending in ${left}s…` : "Sending…";
}

/** The pill's words for a notice. */
export function pillText(notice: PillNotice, now: number): string {
  switch (notice.kind) {
    case "sending":
      return sendingText(notice.deadline, now);
    case "undo":
      return notice.label;
    case "flash":
    case "sync":
      return notice.text;
  }
}

/**
 * What a screen reader hears, once per notice rather than on every tick of the
 * countdown: the words, and that Undo is there when it is.
 */
export function pillAnnouncement(notice: PillNotice | null): string {
  if (notice === null) return "";
  switch (notice.kind) {
    case "sending":
      return "Sending. Undo is available.";
    case "undo":
      return `${notice.label} Undo is available.`;
    case "flash":
    case "sync":
      return notice.text;
  }
}

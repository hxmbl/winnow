/**
 * The sync indicator's rules: a small disc at the top centre of the inbox that says
 * the offline queue (`core/offline/queue.ts`) holds changes, as pure functions so its
 * wording, when it shows and how it comes and goes are tested without React.
 *
 * It replaced a full-width "Syncing 1 change…" bar that sat in the layout and pushed
 * the whole app down and back up every time a change went to Gmail. The disc is fixed
 * over the list (it rides with the status pill, `components/StatusPill.tsx`), so it
 * never moves anything. While a change is on its way it is a small spinner (a static
 * dot under reduced motion); while changes wait (offline, Gmail unreachable, signed
 * out) it is a still cloud. The words ("Syncing 1 change…", "Offline: 3 changes
 * waiting") are its tooltip and a polite live region, the same text the bar showed.
 */

import type { QueueState, QueueStatus } from "../core/offline/queue";
import { offlineStatusText } from "./offlineStatus";

export type SyncBadge = {
  /** What it says to a screen reader and in its tooltip ("Syncing 1 change…"). */
  label: string;
  /** A change is on its way to Gmail: the spinner. Otherwise changes wait: the cloud. */
  busy: boolean;
  waiting: number;
  state: QueueState;
};

/** How long the queue must hold something before the disc shows, ms: a quick sync never flashes it. */
export const SHOW_DELAY_MS = 450;

/** How long the disc takes to fade out, ms (it fades in as quickly). */
export const FADE_MS = 180;

/** The disc's diameter and its gap from the pill, px. The pill is 40px tall. */
export const BADGE_SIZE = 28;
export const BADGE_GAP = 8;

/** The disc for a queue status, or `null` when nothing waits. */
export function syncBadge(status: QueueStatus, online: boolean): SyncBadge | null {
  const label = offlineStatusText(status, online);
  if (label === null) return null;
  const busy = online && status.state !== "auth" && status.state !== "offline" && status.state !== "backoff";
  return { label, busy, waiting: status.waiting, state: status.state };
}

/**
 * The disc's life: `waiting` is the delay before it shows, `leaving` its fade-out.
 * `on`/`off` say whether the queue holds something; `timer` is the end of the
 * current phase's wait.
 */
export type BadgePhase = "hidden" | "waiting" | "shown" | "leaving";

export function nextBadgePhase(phase: BadgePhase, event: "on" | "off" | "timer"): BadgePhase {
  if (event === "on") return phase === "hidden" || phase === "waiting" ? "waiting" : "shown";
  if (event === "off") return phase === "shown" || phase === "leaving" ? "leaving" : "hidden";
  if (phase === "waiting") return "shown";
  if (phase === "leaving") return "hidden";
  return phase;
}

/** How long a phase lasts before its `timer`, ms, or `null` for one that waits for the queue. */
export function badgePhaseMs(phase: BadgePhase): number | null {
  if (phase === "waiting") return SHOW_DELAY_MS;
  if (phase === "leaving") return FADE_MS;
  return null;
}

/**
 * Where the disc sits: beside the pill on its right, like a companion to it, when the
 * pill shows; centred where the pill would be when it doesn't. Either way its middle
 * is level with the pill's.
 */
export function badgePlacement(pillShown: boolean): "beside" | "centre" {
  return pillShown ? "beside" : "centre";
}

/**
 * A forced status for screenshots and smoke tests (`window.__WINNOW_SYNC_PREVIEW__`),
 * honoured only under automation (`navigator.webdriver`), like the tour's opt-in. The
 * demo has no queue, so without it the disc can't be seen there.
 */
export function previewStatus(value: unknown, automated: boolean): QueueStatus | null {
  if (!automated || typeof value !== "object" || value === null) return null;
  const { waiting, sends, state } = value as Partial<QueueStatus>;
  if (typeof waiting !== "number" || !Number.isFinite(waiting) || waiting < 0) return null;
  const states: QueueState[] = ["idle", "replaying", "offline", "backoff", "auth"];
  if (typeof state !== "string" || !states.includes(state)) return null;
  return { waiting: Math.floor(waiting), sends: typeof sends === "number" ? sends : 0, state };
}

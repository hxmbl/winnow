/**
 * The sync indicator's state for the offline queue (`components/SyncIndicator.tsx` draws
 * it, `syncIndicator.ts` has the rules): the disc to show now, after its delay, kept
 * through its fade-out. Never touches the queue; it only listens.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { OfflineQueue, QueueStatus } from "../core/offline/queue";
import { useOnline } from "./useOnline";
import { badgePhaseMs, nextBadgePhase, previewStatus, syncBadge, type BadgePhase, type SyncBadge } from "./syncIndicator";

const IDLE: QueueStatus = { waiting: 0, sends: 0, state: "idle" };

/** The event a test fires after changing `window.__WINNOW_SYNC_PREVIEW__`. */
const PREVIEW_EVENT = "winnow-sync-preview";

let previewKey = "";
let previewValue: QueueStatus | null = null;

function readPreview(): QueueStatus | null {
  const automated = typeof navigator !== "undefined" && navigator.webdriver === true;
  const next = previewStatus((window as { __WINNOW_SYNC_PREVIEW__?: unknown }).__WINNOW_SYNC_PREVIEW__, automated);
  const key = next ? `${next.waiting}/${next.sends}/${next.state}` : "";
  if (key !== previewKey) {
    previewKey = key;
    previewValue = next;
  }
  return previewValue;
}

function subscribePreview(onChange: () => void): () => void {
  window.addEventListener(PREVIEW_EVENT, onChange);
  return () => window.removeEventListener(PREVIEW_EVENT, onChange);
}

export type SyncIndicatorState = { badge: SyncBadge | null; leaving: boolean };

export function useSyncIndicator(queue: OfflineQueue | null): SyncIndicatorState {
  const status = useSyncExternalStore(queue ? queue.subscribe : noopSubscribe, queue ? queue.status : idleStatus, idleStatus);
  const preview = useSyncExternalStore(subscribePreview, readPreview, noPreview);
  const online = useOnline();
  const badge = syncBadge(preview ?? status, online);
  const present = badge !== null;

  const [phase, setPhase] = useState<BadgePhase>("hidden");
  const last = useRef<SyncBadge | null>(null);
  if (badge) last.current = badge;

  useEffect(() => {
    setPhase((current) => nextBadgePhase(current, present ? "on" : "off"));
  }, [present]);
  useEffect(() => {
    const ms = badgePhaseMs(phase);
    if (ms === null) return;
    const timer = window.setTimeout(() => setPhase((current) => nextBadgePhase(current, "timer")), ms);
    return () => window.clearTimeout(timer);
  }, [phase]);

  if (phase === "shown") return { badge: badge ?? last.current, leaving: false };
  if (phase === "leaving") return { badge: last.current, leaving: true };
  return { badge: null, leaving: false };
}

function noopSubscribe(): () => void {
  return () => undefined;
}

function idleStatus(): QueueStatus {
  return IDLE;
}

function noPreview(): QueueStatus | null {
  return null;
}

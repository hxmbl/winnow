/**
 * "Offline: 3 changes waiting": the one line that says the offline queue holds
 * something (`core/offline/queue.ts`). A quiet status line under the notices, not a
 * banner: nothing is wrong, the changes are on screen and will reach Gmail by themselves.
 */

import { useSyncExternalStore } from "react";
import { CloudOff } from "lucide-react";
import type { OfflineQueue } from "../../core/offline/queue";
import { offlineStatusText } from "../offlineStatus";
import { useOnline } from "../useOnline";

const IDLE = { waiting: 0, sends: 0, state: "idle" as const };

export function OfflineIndicator({ queue }: { queue: OfflineQueue | null }) {
  const status = useSyncExternalStore(
    queue ? queue.subscribe : noopSubscribe,
    queue ? queue.status : idleStatus,
    idleStatus,
  );
  const online = useOnline();
  const text = offlineStatusText(status, online);
  if (!text) return null;
  return (
    <div
      role="status"
      data-offline-queue={status.waiting}
      data-offline-state={status.state}
      className="flex animate-appear items-center justify-center gap-1.5 px-4 py-1 text-meta text-ink-muted"
    >
      <CloudOff size={13} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0 truncate tabular-nums">{text}</span>
    </div>
  );
}

function noopSubscribe(): () => void {
  return () => undefined;
}

function idleStatus() {
  return IDLE;
}

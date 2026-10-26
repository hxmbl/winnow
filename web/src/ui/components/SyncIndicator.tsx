/**
 * The sync indicator (the rules are `ui/syncIndicator.ts`): a small frosted disc at
 * the top centre of the inbox while the offline queue holds changes. A spinner while a
 * change is on its way to Gmail, a still cloud while changes wait.
 *
 * It lives in the status pill's fixed row (`StatusPill.tsx`), so it never takes room in
 * the layout: beside the pill on its right when the pill shows, centred where the pill
 * rests when it doesn't. It shows only after the queue has held something for
 * `SHOW_DELAY_MS`, so a quick sync never flashes it, and fades in and out.
 *
 * Accessibility: the disc itself is decoration (`aria-hidden`, with the words as its
 * tooltip); one polite live region, always mounted, says them ("Syncing 1 change…").
 * Reduced motion: no spinning, a still dot in the accent instead.
 */

import { CloudOff } from "lucide-react";
import { BADGE_GAP, BADGE_SIZE, FADE_MS, type SyncBadge } from "../syncIndicator";
import type { SyncIndicatorState } from "../useSyncIndicator";

/** The polite live region: always mounted, so a screen reader hears each change once. */
export function SyncAnnouncer({ badge, leaving }: SyncIndicatorState) {
  const shown = badge && !leaving ? badge : null;
  return (
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-sync-announce="">
      {shown && (
        <span data-offline-queue={shown.waiting} data-offline-state={shown.state}>
          {shown.label}
        </span>
      )}
    </p>
  );
}

/**
 * The disc. Its box is absolutely placed in the pill's row, so it adds nothing to any
 * layout: `beside` hangs it off the pill's right edge, `centre` puts it where the pill
 * would be. Its middle is level with the pill's either way.
 */
export function SyncDisc({ badge, leaving, placement }: { badge: SyncBadge; leaving: boolean; placement: "beside" | "centre" }) {
  return (
    <span
      aria-hidden="true"
      data-sync-indicator={badge.busy ? "busy" : "waiting"}
      data-sync-placement={placement}
      {...(leaving ? { "data-sync-leaving": "" } : {})}
      title={badge.label}
      className={`pointer-events-auto absolute top-1/2 -translate-y-1/2 ${placement === "beside" ? "left-full" : "left-1/2 -translate-x-1/2"}`}
      style={{ width: BADGE_SIZE, height: BADGE_SIZE, ...(placement === "beside" ? { marginLeft: BADGE_GAP } : {}) }}
    >
      <span
        className={`wn-glass wn-liquid flex size-full items-center justify-center rounded-full ${leaving ? "animate-vanish" : "animate-appear"} ${
          badge.busy ? "text-accent" : "text-ink-muted"
        }`}
        style={leaving ? { animationDuration: `${FADE_MS}ms` } : undefined}
      >
        {badge.busy ? (
          <>
            <svg viewBox="0 0 16 16" width="14" height="14" className="animate-spin motion-reduce:hidden" data-sync-spinner="">
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
              <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span className="hidden size-1.5 rounded-full bg-current motion-reduce:block" data-sync-dot="" />
          </>
        ) : (
          <CloudOff size={13} strokeWidth={2.2} className="shrink-0" />
        )}
      </span>
    </span>
  );
}

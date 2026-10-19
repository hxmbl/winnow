/**
 * Pull-to-refresh on the phone's list (the rules are `pullRefresh.ts`).
 *
 * With an account connected the phone list has no briefing strip: a pull down from the
 * very top syncs instead, the same action as the desktop's Sync now. A small frosted
 * circle (`.wn-glass`) with the sync icon comes down from under the top bar, turning
 * with the pull; past the line a haptic tick says letting go will sync; then it spins
 * while the sync runs, and hands over to the status pill (`StatusPill`), which says how it
 * went ("Synced just now", with what is waiting on you, or the error) in the same place
 * and the same glass, so a pull's result and an action's Undo are one surface.
 *
 * Touch events on the list's pane, not pointer events: the rows' swipes are pointer
 * events, and the two share one axis lock, so a touch is only ever one of them. Once a
 * touch is a pull its moves are `preventDefault`ed, so neither the list nor the
 * browser's own overscroll moves under it (the list is `overscroll-behavior: contain`
 * too). Reduced motion: no retract slide, and the spinner stands still with a label.
 */

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  PULL_RESULT_MS,
  crossedThreshold,
  phaseFor,
  pullAllowed,
  pullDistance,
  pullIntent,
  pullRotation,
  type PullContext,
  type PullIntent,
  type PullPhase,
} from "../pullRefresh";

/** Where the indicator rests while it spins and shows the result, px below the top. */
const HOLD = 56;
/** The indicator's size, px; it starts this far above the list's top edge. */
const SIZE = 40;

type Props = {
  /** The list's pane: touches that start on its scroller are watched. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Everything `pullAllowed` needs but the scroll offset and the sync state. */
  context: Omit<PullContext, "scrollTop" | "syncing">;
  syncing: boolean;
  /** Sync, as Sync now does. Resolves when it has finished, either way. */
  onRefresh: () => Promise<unknown> | void;
  /** After the sync: what to say. Read once it has finished, so it is the new line. */
  result: () => { ok: boolean; text: string };
  /** The result, for the status pill to say. */
  onResult: (outcome: { ok: boolean; text: string }) => void;
  /**
   * Where the list's visible top is, in px from the pane's top: the floating top bar's
   * height, since the list now runs up under it. The indicator comes down from there.
   */
  top?: number;
};

export function PullRefresh({ containerRef, context, syncing, onRefresh, result, onResult, top = 0 }: Props) {
  const [phase, setPhase] = useState<PullPhase>("idle");
  const [distance, setDistance] = useState(0);

  // The gesture reads the latest props through a ref, so its listeners attach once.
  const live = useRef({ context, syncing, onRefresh, result, onResult });
  live.current = { context, syncing, onRefresh, result, onResult };
  const busy = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let start: { x: number; y: number; scroller: HTMLElement } | null = null;
    let intent: PullIntent = "pending";
    let travelled = 0;
    let timer: number | null = null;

    const reset = () => {
      start = null;
      intent = "pending";
      travelled = 0;
    };

    const onStart = (event: TouchEvent) => {
      if (busy.current || event.touches.length !== 1) return reset();
      const scroller = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-row-count]");
      const { context: ctx, syncing: now } = live.current;
      if (!scroller || !pullAllowed({ ...ctx, scrollTop: scroller.scrollTop, syncing: now })) return reset();
      const touch = event.touches[0];
      start = { x: touch.clientX, y: touch.clientY, scroller };
      intent = "pending";
      travelled = 0;
    };

    const onMove = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (intent === "pending") {
        intent = pullIntent(dx, dy);
        // A swipe or a scroll: not ours, for the rest of this touch.
        if (intent === "swipe" || intent === "scroll") return reset();
        if (intent === "pending") return;
      }
      if (start.scroller.scrollTop > 0) return reset();
      // Ours: the list and the browser's overscroll stay still under the finger.
      if (event.cancelable) event.preventDefault();
      const next = pullDistance(dy);
      if (crossedThreshold(travelled, next)) navigator.vibrate?.(10);
      travelled = next;
      setDistance(next);
      setPhase(phaseFor(next));
    };

    const onEnd = () => {
      if (!start || intent !== "pull") return reset();
      const armed = phaseFor(travelled) === "armed";
      reset();
      if (!armed) {
        setDistance(0);
        setPhase("idle");
        return;
      }
      busy.current = true;
      setDistance(HOLD);
      setPhase("syncing");
      void Promise.resolve(live.current.onRefresh())
        .catch(() => undefined)
        .then(() => {
          const outcome = live.current.result();
          live.current.onResult(outcome);
          setPhase(outcome.ok ? "done" : "error");
          timer = window.setTimeout(() => {
            busy.current = false;
            setDistance(0);
            setPhase("idle");
          }, PULL_RESULT_MS);
        });
    };

    container.addEventListener("touchstart", onStart, { passive: true });
    // Not passive: a pull cancels the moves it claims.
    container.addEventListener("touchmove", onMove, { passive: false });
    container.addEventListener("touchend", onEnd, { passive: true });
    container.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      container.removeEventListener("touchstart", onStart);
      container.removeEventListener("touchmove", onMove);
      container.removeEventListener("touchend", onEnd);
      container.removeEventListener("touchcancel", onEnd);
      if (timer !== null) window.clearTimeout(timer);
      busy.current = false;
    };
  }, [containerRef]);

  const dragging = phase === "pulling" || phase === "armed";
  const settled = phase === "done" || phase === "error";
  const shown = phase !== "idle";
  // Fades in over the first 40px of the pull; settled, the status pill has taken over.
  const opacity = dragging ? Math.min(1, distance / 40) : shown && !settled ? 1 : 0;

  return (
    <div
      data-pull-indicator={phase}
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center"
      style={{
        top,
        transform: `translateY(${distance - SIZE}px)`,
        opacity,
        // Held, it follows the finger exactly; let go, it eases to rest or back out. The
        // global reduced-motion rule makes that instant.
        transition: dragging ? "none" : "transform 260ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease-out",
      }}
    >
      <div
        className="wn-glass wn-glass-bar flex h-10 w-10 items-center justify-center rounded-full text-ink-body"
        data-dragging={dragging ? "" : undefined}
      >
        <RefreshCw
          size={18}
          strokeWidth={2.2}
          aria-hidden="true"
          className={`shrink-0 ${phase === "syncing" ? "animate-spin" : ""} ${phase === "armed" ? "text-accent" : ""}`}
          style={phase === "syncing" ? undefined : { transform: `rotate(${pullRotation(distance)}deg)` }}
        />
      </div>
    </div>
  );
}

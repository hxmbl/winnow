/**
 * The filter strip's motion: a smoothed wheel with a rubber band at the ends, and the same
 * rubber band under a finger. The numbers live in `railMotion.ts`; this wires them to the DOM.
 *
 * Everything here writes straight to the elements (scrollLeft, a transform) from
 * animation frames and never sets React state, so none of it re-renders the strip.
 *
 * Reduced motion: the wheel moves the strip at once with no glide and no rubber band,
 * and nothing else changes.
 */

import { useEffect, type RefObject } from "react";
import {
  rubberBand,
  smoothStep,
  splitOvershoot,
  springBack,
  wheelDelta,
} from "../railMotion";

/** After this long without a wheel event the strip springs back from an end. */
const WHEEL_IDLE_MS = 90;

const reducedMotion = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function useRailMotion(
  rootRef: RefObject<HTMLElement | null>,
  scrollerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const root = rootRef.current;
    const scroller = scrollerRef.current;
    if (!root || !scroller) return;

    // ── The rubber band: a transform on the scroller, never on a chip (a transform on
    //    a chip would make it a stacking context and put its frost layer over its tint).
    let shown = 0;
    const show = (x: number) => {
      const rounded = Math.round(x * 10) / 10;
      if (rounded === shown) return;
      shown = rounded;
      scroller.style.transform = rounded === 0 ? "" : `translate3d(${rounded}px, 0, 0)`;
      if (rounded === 0) delete scroller.dataset.railStretch;
      else scroller.dataset.railStretch = "";
    };
    let springFrame = 0;
    const spring = () => {
      cancelAnimationFrame(springFrame);
      const from = shown;
      if (from === 0) return;
      if (reducedMotion()) return show(0);
      const start = performance.now();
      const step = (now: number) => {
        const x = springBack(from, now - start);
        show(x);
        if (x !== 0) springFrame = requestAnimationFrame(step);
      };
      springFrame = requestAnimationFrame(step);
    };

    // ── The wheel: smoothed towards a target, the pull past an end accumulated.
    let target: number | null = null;
    let pull = 0;
    let glideFrame = 0;
    let lastFrame = 0;
    let idleTimer = 0;
    const maxScroll = () => Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const glide = (now: number) => {
      if (target === null) return;
      const dt = lastFrame ? now - lastFrame : 16.67;
      lastFrame = now;
      const next = smoothStep(scroller.scrollLeft, target, dt);
      scroller.scrollLeft = next;
      // scrollLeft snaps to device pixels: within one of the target is there.
      if (Math.abs(target - scroller.scrollLeft) < 1) {
        scroller.scrollLeft = target;
        target = null;
        lastFrame = 0;
        return;
      }
      glideFrame = requestAnimationFrame(glide);
    };
    const onWheel = (event: WheelEvent) => {
      // Pinch-zoom on a trackpad arrives as a wheel with ctrl held: the browser's.
      if (event.ctrlKey) return;
      // Over the strip a wheel is the strip's, always: never the list's under it.
      event.preventDefault();
      event.stopPropagation();
      const delta = wheelDelta(event.deltaX, event.deltaY, event.deltaMode, scroller.clientWidth);
      if (delta === 0) return;
      const max = maxScroll();
      if (reducedMotion()) {
        scroller.scrollLeft = Math.min(max, Math.max(0, scroller.scrollLeft + delta));
        return;
      }
      const from = target ?? scroller.scrollLeft;
      const { scroll, overshoot } = splitOvershoot(from + delta, max);
      target = scroll;
      // At an end the pull builds (and lets go as soon as the wheel turns back).
      pull = overshoot !== 0 && Math.sign(overshoot) === Math.sign(pull || overshoot) ? pull + overshoot : 0;
      if (pull !== 0) {
        cancelAnimationFrame(springFrame);
        show(-rubberBand(pull));
      } else if (shown !== 0) spring();
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        pull = 0;
        spring();
      }, WHEEL_IDLE_MS);
      cancelAnimationFrame(glideFrame);
      lastFrame = 0;
      glideFrame = requestAnimationFrame(glide);
    };

    // ── Touch: the browser scrolls the strip (`touch-action: pan-x`); past an end the
    //    finger keeps pulling and the strip follows it, damped, then springs back.
    let touchX: number | null = null;
    let touchScroll = 0;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      cancelAnimationFrame(springFrame);
      target = null;
      touchX = event.touches[0]!.clientX;
      touchScroll = scroller.scrollLeft;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (touchX === null || event.touches.length !== 1 || reducedMotion()) return;
      const wanted = touchScroll - (event.touches[0]!.clientX - touchX);
      const { overshoot } = splitOvershoot(wanted, maxScroll());
      show(-rubberBand(overshoot));
    };
    const onTouchEnd = () => {
      touchX = null;
      spring();
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    scroller.addEventListener("touchend", onTouchEnd, { passive: true });
    scroller.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      root.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
      cancelAnimationFrame(springFrame);
      cancelAnimationFrame(glideFrame);
      window.clearTimeout(idleTimer);
      scroller.style.transform = "";
    };
  }, [rootRef, scrollerRef]);
}

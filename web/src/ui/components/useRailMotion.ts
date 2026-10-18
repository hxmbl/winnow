/**
 * The filter strip's motion: a smoothed wheel with a rubber band at the ends, the same
 * rubber band under a finger, and a subtle motion blur while the list scrolls under it.
 * The numbers live in `railMotion.ts`; this wires them to the DOM.
 *
 * Everything here writes straight to the elements (scrollLeft, a transform, one custom
 * property) from animation frames and never sets React state, so none of it re-renders
 * the strip, and a list scroll costs one property write per frame at most.
 *
 * Reduced motion: the wheel moves the strip at once with no glide and no rubber band,
 * and there is no blur.
 */

import { useEffect, type RefObject } from "react";
import {
  blurForVelocity,
  glideDone,
  glideFrom,
  nextVelocity,
  OUTSIDE_SCROLL_PX,
  rubberBand,
  smoothStep,
  splitOvershoot,
  springBack,
  wheelDelta,
} from "../railMotion";

/** After this long without a wheel event the strip springs back from an end. */
const WHEEL_IDLE_MS = 90;
/** After this long without a list scroll event the list counts as slowing down. */
const LIST_IDLE_MS = 120;

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
    // Where the glide last left scrollLeft, to tell its own writes from anyone else's.
    let written = 0;
    let pull = 0;
    let glideFrame = 0;
    let lastFrame = 0;
    let idleTimer = 0;
    const maxScroll = () => Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const glide = (now: number) => {
      if (target === null) return;
      // Something else scrolled the strip mid-glide: let it, rather than pulling it back.
      if (Math.abs(scroller.scrollLeft - written) > OUTSIDE_SCROLL_PX) {
        target = null;
        lastFrame = 0;
        return;
      }
      const dt = lastFrame ? now - lastFrame : 16.67;
      lastFrame = now;
      const before = scroller.scrollLeft;
      scroller.scrollLeft = smoothStep(before, target, dt);
      written = scroller.scrollLeft;
      // scrollLeft snaps to device pixels: within one of the target, or stuck short of it
      // by the snapping, is there.
      if (glideDone(target, before, scroller.scrollLeft)) {
        scroller.scrollLeft = target;
        written = scroller.scrollLeft;
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
      const from = glideFrom(target, written, scroller.scrollLeft);
      const { scroll, overshoot } = splitOvershoot(from + delta, max);
      target = scroll;
      written = scroller.scrollLeft;
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

    // ── Motion blur while the list scrolls. One capture listener on the document, so
    //    it survives the list remounting; it only records, and the frame does the write.
    let velocity = 0;
    let lastTop: number | null = null;
    let lastTime = 0;
    let blur = 0;
    let blurFrame = 0;
    const writeBlur = (value: number) => {
      if (value === blur) return;
      blur = value;
      if (value === 0) {
        delete scroller.dataset.railMoving;
        scroller.style.removeProperty("--wn-rail-blur");
      } else {
        scroller.style.setProperty("--wn-rail-blur", `${value}px`);
        scroller.dataset.railMoving = "";
      }
    };
    const blurTick = (now: number) => {
      blurFrame = 0;
      // The list has stopped sending scroll events: let the speed fall away smoothly.
      if (now - lastTime > LIST_IDLE_MS) velocity *= 0.6;
      const value = reducedMotion() ? 0 : blurForVelocity(velocity);
      writeBlur(value);
      const idle = now - lastTime > LIST_IDLE_MS;
      if (value !== 0 || Math.abs(velocity) > 0.05 || !idle) blurFrame = requestAnimationFrame(blurTick);
      else {
        // Stopped: the next scroll starts a fresh reading rather than measuring the jump
        // from wherever the list was left.
        velocity = 0;
        lastTop = null;
      }
    };
    const onListScroll = (event: Event) => {
      const list = event.target;
      if (!(list instanceof HTMLElement) || !list.hasAttribute("data-row-count")) return;
      const now = performance.now();
      const top = list.scrollTop;
      if (lastTop !== null) velocity = nextVelocity(velocity, top - lastTop, now - lastTime);
      lastTop = top;
      lastTime = now;
      if (!blurFrame) blurFrame = requestAnimationFrame(blurTick);
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    scroller.addEventListener("touchend", onTouchEnd, { passive: true });
    scroller.addEventListener("touchcancel", onTouchEnd, { passive: true });
    document.addEventListener("scroll", onListScroll, { capture: true, passive: true });
    return () => {
      root.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
      document.removeEventListener("scroll", onListScroll, { capture: true });
      cancelAnimationFrame(springFrame);
      cancelAnimationFrame(glideFrame);
      cancelAnimationFrame(blurFrame);
      window.clearTimeout(idleTimer);
      scroller.style.transform = "";
      scroller.style.removeProperty("--wn-rail-blur");
    };
  }, [rootRef, scrollerRef]);
}

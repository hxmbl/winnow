/**
 * The first-run tour: a spotlight cut around the real control and a small card beside
 * it, five steps, then "go and explore". The decisions (steps, copy, placement, keys,
 * when it starts) are `ui/tour.ts`; this draws them and keeps them in place.
 *
 * - The spotlight follows its target: measured every frame for a moment after each step
 *   (the menu slides in), and again on resize, rotation and scroll. A target that is not
 *   on screen gets the card centred over a plain dim.
 * - The card is a modal dialog with focus held inside it: the menu's own focus hand-off
 *   when it opens is taken back. Escape skips, the arrows step, Enter goes on.
 * - Everything behind is untouchable while it shows, and the app's keyboard shortcuts
 *   are held off, so a stray j or Delete does nothing to the demo mail underneath.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  exploreCopy,
  placeCard,
  spotlightBox,
  stepAfter,
  stepAnnouncement,
  tourKeyAction,
  TOUR_STEP_COUNT,
  visibleTarget,
  type Box,
  type CardPlacement,
  type TourStep,
} from "../tour";
import { buttonClass } from "../button";
import { Icon } from "./Icon";

export type TourEnd = "skip" | "done" | "connect";

type TourProps = {
  steps: readonly TourStep[];
  /** The demo's Connect label ("Connect Gmail"), or `null` with an account open. */
  connectLabel: string | null;
  /** Open or close the menu (the sidebar, or the phone's expanded dock) for a step. */
  onMenu: (open: boolean) => void;
  onConnect: () => void;
  onEnd: (how: TourEnd) => void;
};

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** How long after a step change the spotlight is re-measured every frame (the menu's slide). */
const SETTLE_MS = 700;

function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

function findTarget(step: TourStep): Box | null {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  for (const selector of step.targets) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element || element.getClientRects().length === 0) continue;
    const rect = element.getBoundingClientRect();
    const box = visibleTarget({ top: rect.top, left: rect.left, width: rect.width, height: rect.height }, viewport);
    if (box) return box;
  }
  return null;
}

export function Tour({ steps, connectLabel, onMenu, onConnect, onEnd }: TourProps) {
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const last = index === TOUR_STEP_COUNT - 1;
  const [target, setTarget] = useState<Box | null>(null);
  const [placement, setPlacement] = useState<CardPlacement | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);
  const endedRef = useRef(false);
  /** Connect hands focus to the sign-in it opens, so nothing is given back over it. */
  const restoreOnEndRef = useRef(true);

  const end = useCallback(
    (how: TourEnd) => {
      if (endedRef.current) return;
      endedRef.current = true;
      if (how === "connect") restoreOnEndRef.current = false;
      onMenu(false);
      onEnd(how);
      if (how === "connect") onConnect();
    },
    [onMenu, onEnd, onConnect],
  );

  const go = useCallback(
    (action: "next" | "back") => {
      const next = stepAfter(index, action);
      if (next === null) end("done");
      else setIndex(next);
    },
    [index, end],
  );

  // The menu, opened or closed for the step.
  useEffect(() => {
    onMenu(step.menu);
  }, [step.menu, onMenu]);

  // Focus: remembered on the way in, and given back on the way out.
  useEffect(() => {
    restoreRef.current = document.activeElement;
    return () => {
      const back = restoreRef.current;
      if (restoreOnEndRef.current && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, []);

  // Each step puts focus on the card, so a screen reader reads the new step.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, [index]);

  // Held inside the card: anything that takes focus elsewhere (the menu's own hand-off
  // as it opens) gives it back.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const card = cardRef.current;
      if (card && event.target instanceof Node && !card.contains(event.target)) {
        card.focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  // The keyboard: captured on the window, ahead of the app's shortcuts.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const card = cardRef.current;
      if (!card) return;
      if (event.key === "Tab") {
        const focusable = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (element) => element.getClientRects().length > 0,
        );
        if (focusable.length > 0) {
          const first = focusable[0];
          const lastOne = focusable[focusable.length - 1];
          const active = document.activeElement;
          if (event.shiftKey && (active === first || active === card || !card.contains(active))) {
            event.preventDefault();
            lastOne.focus();
          } else if (!event.shiftKey && (active === lastOne || !card.contains(active))) {
            event.preventDefault();
            first.focus();
          }
        }
        event.stopPropagation();
        return;
      }
      const onButton = document.activeElement instanceof HTMLButtonElement && card.contains(document.activeElement);
      const action = tourKeyAction(event.key, onButton);
      // Every key stops here, so none reaches the app's shortcuts behind the tour; only
      // the keys the tour uses lose their default (Space and Enter still press a button).
      event.stopPropagation();
      if (action === "none") return;
      event.preventDefault();
      if (action === "skip") end("skip");
      else go(action);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, end]);

  // The spotlight, measured: every frame while the step settles, then on resize,
  // rotation and scroll. Written only when the box moves.
  useEffect(() => {
    let frame = 0;
    let current: Box | null | undefined;
    const measure = () => {
      const next = findTarget(step);
      if (current !== undefined && sameBox(current, next)) return;
      current = next;
      setTarget(next);
    };
    const started = performance.now();
    const loop = () => {
      measure();
      if (performance.now() - started < SETTLE_MS) frame = requestAnimationFrame(loop);
      else frame = 0;
    };
    loop();
    const onChange = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("resize", onChange);
    window.addEventListener("orientationchange", onChange);
    document.addEventListener("scroll", onChange, { capture: true, passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", onChange);
      window.removeEventListener("orientationchange", onChange);
      document.removeEventListener("scroll", onChange, { capture: true });
    };
  }, [step]);

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const hole = target ? spotlightBox(target, viewport) : null;

  // The card, placed beside the hole once its own size is known (it depends on the copy
  // and the window's width), and again whenever either changes.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const place = () => {
      const size = { width: card.offsetWidth, height: card.offsetHeight };
      const view = { width: window.innerWidth, height: window.innerHeight };
      const next = placeCard(target ? spotlightBox(target, view) : null, size, view, step.prefer);
      setPlacement((prev) =>
        prev && prev.top === next.top && prev.left === next.left && prev.side === next.side ? prev : next,
      );
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(card);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [target, step]);

  const explore = exploreCopy(connectLabel);
  const body = step.id === "explore" ? explore.body : step.body;
  const titleId = "winnow-tour-title";
  const bodyId = "winnow-tour-body";

  return (
    <div data-tour="" data-tour-step={step.id} data-tour-index={index} className="fixed inset-0 z-80">
      {/* Takes every press meant for the app behind, which stays exactly as it is. */}
      <div
        aria-hidden="true"
        data-tour-blocker=""
        className="absolute inset-0"
        onPointerDown={(event) => event.preventDefault()}
        style={hole ? undefined : { background: "var(--wn-tour-dim)" }}
      />
      {hole && (
        <div
          aria-hidden="true"
          data-tour-spotlight=""
          className="wn-tour-spotlight pointer-events-none absolute rounded-pane"
          style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }}
        />
      )}

      <p aria-live="polite" aria-atomic="true" className="sr-only" data-tour-announcement="">
        {stepAnnouncement(index, step)}
      </p>

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        data-tour-card=""
        data-tour-side={placement?.side ?? "centre"}
        className="wn-tour-card absolute w-[min(340px,calc(100vw-24px))] rounded-pane border border-hairline bg-chrome p-4 text-ink shadow-lift outline-hidden"
        style={{
          top: placement?.top ?? 0,
          left: placement?.left ?? 0,
          // Hidden for the one frame before its size is known, so it never flashes at 0,0.
          visibility: placement ? undefined : "hidden",
        }}
      >
        <div className="-my-1 flex min-h-8 items-center justify-between gap-3 max-sm:min-h-11">
          <p className="text-meta font-semibold tabular-nums text-ink-subtle" data-tour-progress="">
            {index + 1} of {TOUR_STEP_COUNT}
          </p>
          {!last && (
            <button
              type="button"
              data-tour-skip=""
              onClick={() => end("skip")}
              className="-mr-1.5 flex min-h-8 items-center gap-1 rounded-ctl px-2 text-meta font-semibold text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:min-h-11"
            >
              Skip tour
              <Icon icon={X} size={12} />
            </button>
          )}
        </div>
        <h2 id={titleId} data-tour-title="" className="mt-1 text-read font-semibold text-ink">
          {step.title}
        </h2>
        <p id={bodyId} data-tour-body="" className="mt-1 text-ui leading-relaxed text-ink-muted">
          {body}
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-3">
          <ol aria-hidden="true" data-tour-dots="" className="flex items-center gap-1.5">
            {steps.map((item, at) => (
              <li
                key={item.id}
                className={`h-1.5 rounded-full transition-[width,background-color] duration-200 motion-reduce:transition-none ${
                  at === index ? "w-4 bg-accent" : "w-1.5 bg-hairline"
                }`}
              />
            ))}
          </ol>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {last ? (
              <>
                {explore.secondary && (
                  <button
                    type="button"
                    data-tour-explore=""
                    onClick={() => end("done")}
                    className={buttonClass("secondary", "md", "max-sm:min-h-11")}
                  >
                    {explore.secondary}
                  </button>
                )}
                <button
                  type="button"
                  data-tour-primary={connectLabel === null ? "done" : "connect"}
                  onClick={() => end(connectLabel === null ? "done" : "connect")}
                  className={buttonClass("primary", "md", "max-sm:min-h-11")}
                >
                  {explore.primary}
                </button>
              </>
            ) : (
              <>
                {index > 0 && (
                  <button
                    type="button"
                    data-tour-back=""
                    onClick={() => go("back")}
                    className={buttonClass("secondary", "md", "max-sm:min-h-11")}
                  >
                    Back
                  </button>
                )}
                <button
                  type="button"
                  data-tour-next=""
                  onClick={() => go("next")}
                  className={buttonClass("primary", "md", "max-sm:min-h-11")}
                >
                  Next
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

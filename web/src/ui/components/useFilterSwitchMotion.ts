/**
 * The list's motion when the smart filters or the mailbox change (see `filterMotion.ts`
 * for what moves and how fast): leaving rows fade out as ghosts, staying rows slide to
 * their new places, new rows fade in.
 *
 * Only a switch animates. The key is the mailbox and its filters (`viewKey`), so a sync
 * that adds or drops rows, a search being typed, a new sort, scrolling, an archive (which
 * has its own exit, `rowExit.ts`) all leave this alone.
 *
 * How it is done, and why each part is where it is:
 *
 * - **Snapshot, in render.** FLIP needs every row's place *before* React moves it, and a
 *   function component has no `getSnapshotBeforeUpdate`; by the time any effect runs,
 *   the rows that left are gone from the DOM. So the render that sees a new view reads
 *   the mounted rows' boxes, and clones the ones on screen as ghosts, before it returns.
 *   It is a read of a DOM React has not touched yet, guarded to once per view, so a
 *   render that is repeated (strict mode) or thrown away costs a few measurements.
 * - **Play, in a layout effect.** After the commit, and only once the list's window has
 *   caught up with the scroll position (a new view starts at the top, which takes one
 *   more synchronous commit), the rows are measured again and the motion starts, all
 *   before the first paint of the new list, so no frame shows rows in the wrong place.
 * - **Web Animations, not React state.** Every frame is the compositor's (opacity,
 *   transform, a small filter on the ghosts); nothing here renders per frame.
 * - **A new switch snaps the old one.** Before it measures, a switch cancels whatever the
 *   last one still has running and removes its ghosts, so a keyboard user flicking
 *   through filters with the digit keys never queues motion behind motion.
 *
 * Ghosts are stripped of their data attributes (`ghostOf`), so `[data-message-id]` and
 * `[data-row-id]` only ever find real rows, mid-switch included.
 *
 * Reduced motion: no snapshot, so nothing to play; the switch is a cut.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import {
  arrival,
  enterKeyframes,
  leaveKeyframes,
  leavers,
  moveKeyframes,
  shouldAnimateSwitch,
  staggerDelays,
  SWITCH_ENTER_DELAY_MS,
  SWITCH_ENTER_EASING,
  SWITCH_ENTER_MS,
  SWITCH_ENTER_STEP_MS,
  SWITCH_LEAVE_EASING,
  SWITCH_LEAVE_MS,
  SWITCH_LEAVE_SPREAD_MS,
  SWITCH_LEAVE_STEP_MS,
  SWITCH_MOVE_DELAY_MS,
  SWITCH_MOVE_EASING,
  SWITCH_MOVE_MS,
  SWITCH_SNAPSHOT_TTL_MS,
  type Band,
  type ItemBox,
} from "../filterMotion";
import { ghostOf } from "../rowExit";

/** What the switching render saw, waiting to be played after the commit. */
type Snapshot = {
  view: string;
  at: number;
  /** Every mounted item's top on screen, by key, for the slide. */
  tops: Map<string, number>;
  /** The on-screen items, in case they turn out to be leaving. */
  boxes: ItemBox[];
  /** A ghost for each on-screen item, by key; only the leavers' are used. */
  ghosts: Map<string, HTMLElement>;
};

/** What a played switch still has going, so the next one can snap it. */
type Running = { animations: Animation[]; ghosts: HTMLElement[]; timer: ReturnType<typeof setTimeout> | null };

const reducedMotion = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** The scroller's visible band: below whatever floats over its top. */
function bandOf(scroller: HTMLElement, topInset: number): Band {
  const box = scroller.getBoundingClientRect();
  return { top: box.top + topInset, bottom: box.bottom };
}

function mountedItems(scroller: HTMLElement): HTMLElement[] {
  return [...scroller.querySelectorAll<HTMLElement>("[data-item-key]")];
}

function stop(running: Running | null): void {
  if (!running) return;
  for (const animation of running.animations) animation.cancel();
  for (const ghost of running.ghosts) ghost.remove();
  if (running.timer !== null) clearTimeout(running.timer);
}

function snapshot(scroller: HTMLElement, view: string, topInset: number): Snapshot {
  const band = bandOf(scroller, topInset);
  const tops = new Map<string, number>();
  const boxes: ItemBox[] = [];
  const ghosts = new Map<string, HTMLElement>();
  for (const element of mountedItems(scroller)) {
    const key = element.dataset.itemKey;
    if (!key) continue;
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) continue;
    tops.set(key, rect.top);
    const box = { key, top: rect.top, bottom: rect.bottom };
    if (box.bottom > band.top && box.top < band.bottom) {
      boxes.push(box);
      ghosts.set(key, ghostOf(element, rect, band));
    }
  }
  return { view, at: performance.now(), tops, boxes, ghosts };
}

function play(shot: Snapshot, scroller: HTMLElement, topInset: number): Running {
  const host = scroller.parentElement;
  const band = bandOf(scroller, topInset);
  const animations: Animation[] = [];
  const used: HTMLElement[] = [];

  const items = mountedItems(scroller);
  const mounted = new Set(items.map((element) => element.dataset.itemKey ?? ""));

  // Leave: ghosts of the rows that went, over the spots they left.
  const leaving = host ? leavers(shot.boxes, mounted, band) : [];
  const leaveDelays = staggerDelays(leaving.length, {
    step: SWITCH_LEAVE_STEP_MS,
    duration: SWITCH_LEAVE_MS,
    spread: SWITCH_LEAVE_SPREAD_MS,
  });
  leaving.forEach((box, index) => {
    const ghost = shot.ghosts.get(box.key);
    if (!ghost || !host) return;
    host.appendChild(ghost);
    used.push(ghost);
    animations.push(
      ghost.animate(leaveKeyframes(), {
        duration: SWITCH_LEAVE_MS,
        delay: leaveDelays[index],
        easing: SWITCH_LEAVE_EASING,
        fill: "forwards",
      }),
    );
  });

  // Move and enter, judged against where each row was.
  const entering: HTMLElement[] = [];
  for (const element of items) {
    const key = element.dataset.itemKey;
    if (!key) continue;
    const rect = element.getBoundingClientRect();
    const next = arrival(shot.tops.get(key), { key, top: rect.top, bottom: rect.bottom }, band);
    if (next.kind === "move") {
      animations.push(
        element.animate(moveKeyframes(next.from), {
          duration: SWITCH_MOVE_MS,
          delay: SWITCH_MOVE_DELAY_MS,
          easing: SWITCH_MOVE_EASING,
          // Held at the old place through the beat before the slide.
          fill: "backwards",
        }),
      );
    } else if (next.kind === "enter") {
      entering.push(element);
    }
  }
  const enterDelays = staggerDelays(entering.length, {
    base: SWITCH_ENTER_DELAY_MS,
    step: SWITCH_ENTER_STEP_MS,
    duration: SWITCH_ENTER_MS,
  });
  entering.forEach((element, index) => {
    animations.push(
      element.animate(enterKeyframes(), {
        duration: SWITCH_ENTER_MS,
        delay: enterDelays[index],
        easing: SWITCH_ENTER_EASING,
        // Invisible through its delay, not shown and then hidden.
        fill: "backwards",
      }),
    );
  });

  // Ghosts go when their fade does, and in any case shortly after: a background tab
  // can hold an animation's finish event indefinitely.
  const running: Running = { animations, ghosts: used, timer: null };
  for (const [index, ghost] of used.entries()) {
    const animation = animations[index];
    const done = () => ghost.remove();
    animation?.addEventListener("finish", done);
    animation?.addEventListener("cancel", done);
  }
  if (used.length > 0) {
    running.timer = setTimeout(() => {
      for (const ghost of used) ghost.remove();
    }, SWITCH_LEAVE_MS + SWITCH_LEAVE_SPREAD_MS + 150);
  }
  return running;
}

/**
 * Animate the list across a change of `view` (mailbox and smart filters).
 *
 * `settled` says whether the mounted rows are the ones the scroll position calls for; a
 * switch waits for that before it measures the new rows (see the note above).
 * `topInset` is the floating chrome over the list's top, under which nothing counts as
 * on screen.
 */
export function useFilterSwitchMotion(
  scroller: HTMLElement | null,
  view: string,
  topInset: number,
  settled: () => boolean,
): void {
  const seen = useRef<string | null>(null);
  const pending = useRef<Snapshot | null>(null);
  const running = useRef<Running | null>(null);

  // The snapshot, in render: the one moment the old rows are still where they were.
  if (seen.current !== view) {
    const previous = seen.current;
    seen.current = view;
    pending.current = null;
    if (previous !== null) {
      // Snap whatever the last switch still has going before measuring, or the
      // measurement would catch rows mid-slide.
      stop(running.current);
      running.current = null;
    }
    const animate =
      scroller !== null &&
      shouldAnimateSwitch({
        previous,
        next: view,
        reducedMotion: reducedMotion(),
        listShown: scroller.clientHeight > 0 && globalThis.document?.visibilityState !== "hidden",
        canAnimate: typeof scroller.animate === "function",
      });
    if (animate) pending.current = snapshot(scroller, view, topInset);
  }

  // The play, after every commit until the window has caught up (usually the first or the
  // second), and never for a snapshot that has gone stale or another view's.
  useLayoutEffect(() => {
    const shot = pending.current;
    if (!shot) return;
    if (shot.view !== view || !scroller || !scroller.isConnected || performance.now() - shot.at > SWITCH_SNAPSHOT_TTL_MS) {
      pending.current = null;
      return;
    }
    if (!settled()) return;
    pending.current = null;
    running.current = play(shot, scroller, topInset);
  });

  useEffect(
    () => () => {
      stop(running.current);
      running.current = null;
    },
    [],
  );
}

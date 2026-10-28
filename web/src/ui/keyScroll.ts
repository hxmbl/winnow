/**
 * Smooth keyboard scrolling for the reader: ↓ / ↑ move the open message a step at a
 * time on an ease-out curve instead of jumping.
 *
 * Driven by `requestAnimationFrame` writing `scrollTop`, not CSS `scroll-behavior:
 * smooth` or `scrollBy({ behavior: "smooth" })`: in WebView (and Android's above all)
 * those restart on every call, so a held key stutters or stalls, and each engine picks
 * its own curve. Here a press adds its step to whatever distance is still to go, and
 * the curve restarts from where the content is now, so a held key glides.
 *
 * The message list reuses the same animator for the scroll that keeps the cursor's row in
 * view after `j` / `k` (`smoothScrollTo`): the cursor moves at once, only the list's
 * scroll glides, and a press mid-glide retargets the curve from where the list is now.
 *
 * The math is pure and tested (`keyScroll.test.ts`); `smoothScrollBy` and
 * `smoothScrollTo` are the thin DOM driver around it.
 */

/** How far one press moves the reader, in CSS pixels. Unchanged from the instant scroll. */
export const KEY_SCROLL_STEP = 120;

/** How long one glide takes from its latest press, in ms. */
export const KEY_SCROLL_DURATION = 160;

/** Ease-out cubic: fast off the mark, settling gently. `t` is clamped to [0, 1]. */
export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** One glide in flight: from `from` at `start` to `to` over `duration` ms. */
export type Glide = {
  from: number;
  to: number;
  start: number;
  duration: number;
};

/**
 * The glide after a press of `delta` pixels.
 *
 * `current` is where the content sits now and `glide` the one in flight, if any. The
 * new target is the old target plus `delta` (so presses add up rather than restart),
 * clamped to `[0, max]`; the curve starts again from `current` so nothing jumps.
 * Under reduced motion the glide has no duration and lands at once.
 */
export function retarget(
  glide: Glide | null,
  current: number,
  delta: number,
  now: number,
  max: number,
  reducedMotion: boolean,
  duration: number = KEY_SCROLL_DURATION,
): Glide {
  const limit = Math.max(0, max);
  const base = glide ? glide.to : current;
  const to = clamp(base + delta, 0, limit);
  return { from: clamp(current, 0, limit), to, start: now, duration: reducedMotion ? 0 : duration };
}

/**
 * The glide to an absolute `target` (the list's reveal), from `current`, clamped to
 * `[0, max]`. Unlike `retarget` nothing adds up: a new reveal names where the list
 * should end, so the old target is simply replaced. The curve restarts from `current`,
 * so a retarget mid-glide never jumps. Instant under reduced motion.
 */
export function retargetTo(
  current: number,
  target: number,
  now: number,
  max: number,
  reducedMotion: boolean,
  duration: number = KEY_SCROLL_DURATION,
): Glide {
  const limit = Math.max(0, max);
  return {
    from: clamp(current, 0, limit),
    to: clamp(target, 0, limit),
    start: now,
    duration: reducedMotion ? 0 : duration,
  };
}

/**
 * How far, in viewports, a reveal may glide before it jumps instead. A deep link or a
 * jump to a far row would otherwise race past screens of rows the windowed list has not
 * mounted yet, flashing blank space; `j` / `k` move at most about a screen.
 */
export const GLIDE_MAX_VIEWPORTS = 2;

/** Whether a move from `from` to `to` is short enough to glide in a `viewport`-tall scroller. */
export function glideable(from: number, to: number, viewport: number): boolean {
  return Math.abs(to - from) <= GLIDE_MAX_VIEWPORTS * Math.max(0, viewport);
}

/** Where the glide puts the content at `now`, and whether it has arrived. */
export function positionAt(glide: Glide, now: number): { top: number; done: boolean } {
  if (glide.duration <= 0) return { top: glide.to, done: true };
  const t = (now - glide.start) / glide.duration;
  if (t >= 1) return { top: glide.to, done: true };
  return { top: glide.from + (glide.to - glide.from) * easeOutCubic(t), done: false };
}

// ── The DOM driver ──────────────────────────────────────────────────────────

type Flight = { glide: Glide; frame: number; written: number; onDone?: () => void };

const flights = new WeakMap<HTMLElement, Flight>();

/** More than this between what we wrote and what the element reports means someone else scrolled. */
const TAKEOVER_PX = 2;

const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Stop any glide on `el` where it is (a new message, a touch, unmount). */
export function stopSmoothScroll(el: HTMLElement | null): void {
  if (!el) return;
  const flight = flights.get(el);
  if (!flight) return;
  cancelAnimationFrame(flight.frame);
  flights.delete(el);
}

/** The glide in flight on `el`, dropped if a wheel, a drag or a scrollbar moved it since. */
function liveFlight(el: HTMLElement): Flight | undefined {
  const flight = flights.get(el);
  if (flight && Math.abs(el.scrollTop - flight.written) > TAKEOVER_PX) {
    stopSmoothScroll(el);
    return undefined;
  }
  return flight;
}

/**
 * Where `el` is gliding to, or null when it is still. Callers that judge "is this row in
 * view" mid-glide judge it at the destination, so a press during a glide does not aim
 * from a half-way position.
 */
export function smoothScrollTarget(el: HTMLElement): number | null {
  return liveFlight(el)?.glide.to ?? null;
}

/** Start `glide` on `el`, or swap it into the glide already in flight. */
function fly(el: HTMLElement, flight: Flight | undefined, glide: Glide, onDone?: () => void): void {
  const step = (now: number) => {
    const live = flights.get(el);
    if (!live) return;
    if (Math.abs(el.scrollTop - live.written) > TAKEOVER_PX) {
      flights.delete(el);
      return;
    }
    // The content can grow or shrink under us (images loading, rows measured), so clamp
    // to today's bottom.
    const bottom = Math.max(0, el.scrollHeight - el.clientHeight);
    const { top, done } = positionAt(live.glide, now);
    el.scrollTop = clamp(top, 0, bottom);
    // Read back what the engine kept (it may round to device pixels).
    live.written = el.scrollTop;
    if (done) {
      flights.delete(el);
      live.onDone?.();
    } else live.frame = requestAnimationFrame(step);
  };

  if (flight) {
    flight.glide = glide;
    // The latest press owns what happens on arrival.
    flight.onDone = onDone;
  } else {
    const fresh: Flight = { glide, frame: 0, written: el.scrollTop, onDone };
    flights.set(el, fresh);
    fresh.frame = requestAnimationFrame(step);
  }
}

/**
 * Glide `el` by `delta` pixels, adding to any glide already in flight. Instant under
 * `prefers-reduced-motion`.
 */
export function smoothScrollBy(el: HTMLElement, delta: number): void {
  const max = el.scrollHeight - el.clientHeight;
  const reduce = prefersReducedMotion();
  const flight = liveFlight(el);
  const current = flight ? flight.written : el.scrollTop;
  const glide = retarget(flight?.glide ?? null, current, delta, performance.now(), max, reduce);

  if (glide.duration === 0) {
    stopSmoothScroll(el);
    el.scrollTop = glide.to;
    return;
  }
  fly(el, flight, glide);
}

/**
 * Glide `el` to `top`, replacing any glide in flight (the curve restarts from where it
 * is now). Lands at once, and returns false, under `prefers-reduced-motion` or when the
 * move is longer than `GLIDE_MAX_VIEWPORTS` screens; `onDone` then runs right away,
 * otherwise once the glide arrives. A wheel or touch mid-glide stops it, and `onDone`
 * never runs.
 */
export function smoothScrollTo(el: HTMLElement, top: number, onDone?: () => void): boolean {
  const max = el.scrollHeight - el.clientHeight;
  const flight = liveFlight(el);
  const current = flight ? flight.written : el.scrollTop;
  const reduce = prefersReducedMotion() || !glideable(current, top, el.clientHeight);
  const glide = retargetTo(current, top, performance.now(), max, reduce);

  if (glide.duration === 0) {
    stopSmoothScroll(el);
    el.scrollTop = glide.to;
    onDone?.();
    return false;
  }
  fly(el, flight, glide, onDone);
  return true;
}

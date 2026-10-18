/**
 * Writing the mailbox cache without stalling the page.
 *
 * The cache is one JSON blob in `localStorage` (see `localCache` in `session.ts`), and
 * serialising a few thousand messages takes tens of milliseconds: done in one go on a
 * timer it lands in the middle of whatever the user is doing (a scroll, `j` held down)
 * as a dropped frame. So a write is spread over idle time instead:
 *
 * - **Idle, with a deadline.** The work waits for `requestIdleCallback`, with a timeout
 *   (`IDLE_TIMEOUT_MS`) so a page that is never idle still saves; where the API is
 *   missing (Safari) a short `setTimeout` stands in, with a small time budget.
 * - **In chunks.** Each idle slice serialises `CHUNK_ROWS` messages at a time while the
 *   slice has time left, keeping the pieces; the last slice joins them and makes the one
 *   `setItem`, which is unavoidable. A change to the mailbox mid-way restarts from the
 *   new state, so what lands is never a mix of two moments.
 * - **Nothing lost.** Leaving the page (`pagehide`, or the tab going hidden) writes any
 *   pending change at once, synchronously, as does `flush()`, which the sync engine calls
 *   before recording a cursor.
 *
 * Pure apart from the scheduler and lifecycle hooks, which are injectable so the tests
 * can drive every slice by hand.
 */

/** What an idle callback is told: how long it may run, and whether it is overdue. */
export type IdleDeadline = { timeRemaining(): number; didTimeout: boolean };

export type IdleScheduler = {
  request(callback: (deadline: IdleDeadline) => void, timeoutMs: number): unknown;
  cancel(handle: unknown): void;
};

/** The longest a pending write waits for the page to go idle. */
export const IDLE_TIMEOUT_MS = 1500;
/** Messages serialised per step; a step is a few hundred microseconds. */
export const CHUNK_ROWS = 150;
/** The time budget the `setTimeout` stand-in pretends an idle slice has. */
const FALLBACK_BUDGET_MS = 8;

type IdleGlobal = {
  requestIdleCallback?: (callback: (deadline: IdleDeadline) => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/** `requestIdleCallback` where there is one, a short timer where there is not. */
export function defaultIdleScheduler(): IdleScheduler {
  const g = globalThis as unknown as IdleGlobal;
  if (typeof g.requestIdleCallback === "function" && typeof g.cancelIdleCallback === "function") {
    return {
      request: (callback, timeoutMs) => g.requestIdleCallback!(callback, { timeout: timeoutMs }),
      cancel: (handle) => g.cancelIdleCallback!(handle as number),
    };
  }
  return {
    request: (callback) =>
      setTimeout(() => {
        const start = Date.now();
        callback({ didTimeout: false, timeRemaining: () => Math.max(0, FALLBACK_BUDGET_MS - (Date.now() - start)) });
      }, 50),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

type LifecycleTarget = {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  document?: { visibilityState?: string; addEventListener?: (type: string, listener: () => void) => void; removeEventListener?: (type: string, listener: () => void) => void };
};

/**
 * Call `flushNow` when the page is going away or out of sight: `pagehide` (the one event
 * every browser fires on the way out, bfcache included) and `visibilitychange` to
 * hidden (the last reliable moment on a phone, where a backgrounded tab may simply be
 * killed). Returns the unsubscribe. Does nothing where there is no page.
 */
export function onPageLeave(flushNow: () => void): () => void {
  const g = globalThis as unknown as LifecycleTarget;
  const onHide = () => flushNow();
  const onVisibility = () => {
    if (g.document?.visibilityState === "hidden") flushNow();
  };
  g.addEventListener?.("pagehide", onHide);
  g.document?.addEventListener?.("visibilitychange", onVisibility);
  return () => {
    g.removeEventListener?.("pagehide", onHide);
    g.document?.removeEventListener?.("visibilitychange", onVisibility);
  };
}

export type IdleWriter = {
  /** Something changed: write it when the page has time. */
  schedule(): void;
  /** Write any pending change now, synchronously. Returns whether one was pending. */
  flushNow(): boolean;
  /** Drop any pending write (the cache was cleared). */
  cancel(): void;
  /** Whether a write is pending. */
  pending(): boolean;
  /** For tests: the rows of the write in progress have changed under it. */
  readonly _restarts: () => number;
};

/**
 * A writer that serialises `rows()` as a JSON array over idle slices and hands the text
 * to `commit`. `rows` is read when a pass starts; `schedule` after a change marks the
 * pass stale so the next slice starts again from the new rows.
 */
export function createIdleWriter<T>(options: {
  rows: () => readonly T[] | null;
  commit: (json: string) => void;
  scheduler?: IdleScheduler;
  chunkRows?: number;
  timeoutMs?: number;
}): IdleWriter {
  const scheduler = options.scheduler ?? defaultIdleScheduler();
  const chunk = Math.max(1, options.chunkRows ?? CHUNK_ROWS);
  const timeout = options.timeoutMs ?? IDLE_TIMEOUT_MS;
  /** Bumped by every change; a pass belongs to the generation it started in. */
  let generation = 0;
  let dirty = false;
  let handle: unknown = null;
  let pass: { generation: number; rows: readonly T[]; next: number; parts: string[] } | null = null;
  let restarts = 0;
  /** Passes restarted since the last write landed: a mailbox that keeps changing. */
  let restartsInRow = 0;

  const finish = (parts: string[]) => {
    pass = null;
    dirty = false;
    restartsInRow = 0;
    options.commit(`[${parts.join(",")}]`);
  };

  const step = (deadline: IdleDeadline) => {
    handle = null;
    if (!dirty) return;
    if (!pass || pass.generation !== generation) {
      if (pass) {
        restarts += 1;
        restartsInRow += 1;
      }
      const rows = options.rows();
      if (!rows) {
        dirty = false;
        pass = null;
        return;
      }
      pass = { generation, rows, next: 0, parts: [] };
    }
    const current = pass;
    // A sync that changes the mailbox faster than a pass can finish would restart it
    // for ever: after two restarts the pass runs to the end in this slice.
    const finishNow = deadline.didTimeout || restartsInRow >= 2;
    // At least one chunk per slice, so a page that is never idle still gets there.
    do {
      const slice = current.rows.slice(current.next, current.next + chunk);
      current.next += slice.length;
      if (slice.length > 0) current.parts.push(JSON.stringify(slice).slice(1, -1));
    } while (current.next < current.rows.length && (finishNow || deadline.timeRemaining() > 1));
    if (current.next >= current.rows.length) finish(current.parts);
    else handle = scheduler.request(step, timeout);
  };

  return {
    schedule() {
      generation += 1;
      dirty = true;
      if (handle === null) handle = scheduler.request(step, timeout);
    },
    flushNow() {
      if (handle !== null) scheduler.cancel(handle);
      handle = null;
      if (!dirty) return false;
      const rows = options.rows();
      pass = null;
      dirty = false;
      restartsInRow = 0;
      if (rows) options.commit(JSON.stringify(rows));
      return true;
    },
    cancel() {
      if (handle !== null) scheduler.cancel(handle);
      handle = null;
      pass = null;
      dirty = false;
    },
    pending: () => dirty,
    _restarts: () => restarts,
  };
}

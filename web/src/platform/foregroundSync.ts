/**
 * Fast polling while the user is looking.
 *
 * Winnow has no server, so there is no push (Gmail's push needs a Pub/Sub topic and
 * something to receive it). What it has instead is that an incremental sync which
 * finds nothing costs one `history.list` — 2 quota units — so it can afford to ask
 * often while someone is actually at the window:
 *
 *   - every `FOREGROUND_POLL_SECONDS` while the document is visible *and* focused;
 *   - at once when the window regains focus, the tab becomes visible again, or the
 *     network comes back (`online`) — the three moments new mail is most likely to
 *     have piled up unseen.
 *
 * Hidden or unfocused, this goes quiet and the platform's background ticker (the
 * user's interval: `set_background_sync` on the desktop, `web.ts` in a browser)
 * carries on at its slower pace. `active()` lets the caller drop those background
 * ticks while this one is running, so the two never double up.
 *
 * Shared by both builds: the Tauri webview fires the same DOM events as a browser.
 */

/** Poll interval while visible and focused. */
export const FOREGROUND_POLL_SECONDS = 30;

/**
 * Wake-ups closer together than this collapse into one sync. Focusing a window from
 * another app fires `visibilitychange` and `focus` back to back; one sync is enough.
 */
export const WAKE_DEBOUNCE_MS = 2_000;

type Listenable = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/** Everything the controller touches, injectable so tests drive it without a DOM. */
export type ForegroundEnv = {
  document?: Listenable & { visibilityState?: string; hasFocus?: () => boolean };
  window?: Listenable;
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  now: () => number;
};

export type ForegroundSync = {
  /** True while the fast cadence is running (visible and focused). */
  active(): boolean;
  /** Remove every listener and stop the timer. */
  stop(): void;
};

function defaultEnv(): ForegroundEnv {
  return {
    document: globalThis.document as ForegroundEnv["document"],
    window: (typeof globalThis.addEventListener === "function" ? globalThis : undefined) as
      | Listenable
      | undefined,
    setInterval: (handler, ms) => globalThis.setInterval(handler, ms),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
    now: () => Date.now(),
  };
}

/**
 * Start the controller. `refresh` is called on each poll and wake-up; it must be
 * safe to call while a sync is already running (the store's `refresh` is).
 */
export function startForegroundSync(
  refresh: () => void,
  env: ForegroundEnv = defaultEnv(),
  intervalSeconds: number = FOREGROUND_POLL_SECONDS,
): ForegroundSync {
  let timer: unknown = null;
  let lastWake = Number.NEGATIVE_INFINITY;

  const visible = (): boolean => env.document?.visibilityState !== "hidden";
  // No `hasFocus` (some embedded webviews) means "assume focused when visible".
  const focused = (): boolean => env.document?.hasFocus?.() ?? true;
  const isActive = (): boolean => visible() && focused();

  const tick = (): void => {
    lastWake = env.now();
    refresh();
  };

  const evaluate = (): void => {
    if (isActive()) {
      if (timer === null) timer = env.setInterval(tick, intervalSeconds * 1000);
    } else if (timer !== null) {
      env.clearInterval(timer);
      timer = null;
    }
  };

  /** A moment worth syncing at once, unless one just happened. */
  const wake = (): void => {
    evaluate();
    if (!visible()) return;
    const now = env.now();
    if (now - lastWake < WAKE_DEBOUNCE_MS) return;
    lastWake = now;
    // Restart the interval so the next poll is a full period after this sync.
    if (timer !== null) {
      env.clearInterval(timer);
      timer = env.setInterval(tick, intervalSeconds * 1000);
    }
    refresh();
  };

  const onVisibility = (): void => {
    if (visible()) wake();
    else evaluate();
  };

  env.document?.addEventListener("visibilitychange", onVisibility);
  env.window?.addEventListener("focus", wake);
  env.window?.addEventListener("blur", evaluate);
  env.window?.addEventListener("online", wake);
  evaluate();

  return {
    active: () => timer !== null,
    stop: () => {
      env.document?.removeEventListener("visibilitychange", onVisibility);
      env.window?.removeEventListener("focus", wake);
      env.window?.removeEventListener("blur", evaluate);
      env.window?.removeEventListener("online", wake);
      if (timer !== null) env.clearInterval(timer);
      timer = null;
    },
  };
}

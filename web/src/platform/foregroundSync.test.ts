import { describe, expect, it } from "vitest";
import {
  FOREGROUND_POLL_SECONDS,
  WAKE_DEBOUNCE_MS,
  startForegroundSync,
  type ForegroundEnv,
} from "./foregroundSync";

/** A hand-cranked DOM: visibility, focus, events and a clock the test moves. */
function fakeEnv(initial: { visible?: boolean; focused?: boolean } = {}) {
  let visible = initial.visible ?? true;
  let focused = initial.focused ?? true;
  let now = 0;
  const listeners = new Map<string, Set<() => void>>();
  const timers = new Map<number, { handler: () => void; ms: number; next: number }>();
  let nextHandle = 1;

  const target = (prefix: string) => ({
    addEventListener: (type: string, fn: () => void) => {
      const key = `${prefix}:${type}`;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(`${prefix}:${type}`)?.delete(fn),
  });

  const env: ForegroundEnv = {
    document: {
      ...target("doc"),
      get visibilityState() {
        return visible ? "visible" : "hidden";
      },
      hasFocus: () => focused,
    },
    window: target("win"),
    setInterval: (handler, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { handler, ms, next: now + ms });
      return handle;
    },
    clearInterval: (handle) => void timers.delete(handle as number),
    now: () => now,
  };

  const fire = (key: string) => {
    for (const fn of [...(listeners.get(key) ?? [])]) fn();
  };

  return {
    env,
    timers,
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.values()].filter((t) => t.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.ms;
        due.handler();
      }
      now = end;
    },
    hide() {
      visible = false;
      fire("doc:visibilitychange");
    },
    show() {
      visible = true;
      fire("doc:visibilitychange");
    },
    blur() {
      focused = false;
      fire("win:blur");
    },
    focus() {
      focused = true;
      fire("win:focus");
    },
    online() {
      fire("win:online");
    },
  };
}

describe("foreground sync", () => {
  it("polls every 10s while visible and focused", () => {
    expect(FOREGROUND_POLL_SECONDS).toBe(10);
    const dom = fakeEnv();
    let refreshes = 0;
    const sync = startForegroundSync(() => void (refreshes += 1), dom.env);
    expect(sync.active()).toBe(true);
    dom.advance(FOREGROUND_POLL_SECONDS * 1000 * 3);
    expect(refreshes).toBe(3);
    sync.stop();
  });

  it("goes quiet when the window loses focus or the tab is hidden", () => {
    const dom = fakeEnv();
    let refreshes = 0;
    const sync = startForegroundSync(() => void (refreshes += 1), dom.env);
    dom.blur();
    expect(sync.active()).toBe(false);
    dom.advance(5 * 60_000);
    expect(refreshes).toBe(0);

    dom.focus();
    refreshes = 0;
    dom.hide();
    expect(sync.active()).toBe(false);
    dom.advance(5 * 60_000);
    expect(refreshes).toBe(0);
    sync.stop();
  });

  it("syncs at once on focus, on becoming visible, and on coming back online", () => {
    const dom = fakeEnv({ focused: false });
    let refreshes = 0;
    const sync = startForegroundSync(() => void (refreshes += 1), dom.env);
    expect(refreshes).toBe(0);

    dom.focus();
    expect(refreshes).toBe(1);
    expect(sync.active()).toBe(true);

    dom.advance(WAKE_DEBOUNCE_MS);
    dom.hide();
    dom.show();
    expect(refreshes).toBe(2);

    dom.advance(WAKE_DEBOUNCE_MS);
    dom.online();
    expect(refreshes).toBe(3);
    sync.stop();
  });

  it("collapses a focus and a visibilitychange fired together into one sync", () => {
    const dom = fakeEnv({ visible: false, focused: false });
    let refreshes = 0;
    const sync = startForegroundSync(() => void (refreshes += 1), dom.env);
    dom.show();
    dom.focus();
    expect(refreshes).toBe(1);
    sync.stop();
  });

  it("restarts the interval after a wake, so the next poll is a full period later", () => {
    const dom = fakeEnv();
    let refreshes = 0;
    const sync = startForegroundSync(() => void (refreshes += 1), dom.env);
    dom.advance(7_000);
    dom.online(); // wake at 7s
    expect(refreshes).toBe(1);
    dom.advance(5_000); // 12s: the original 10s tick must not have fired
    expect(refreshes).toBe(1);
    dom.advance(5_000); // 17s = wake + 10s
    expect(refreshes).toBe(2);
    sync.stop();
  });

  it("does not sync on 'online' while the tab is hidden", () => {
    const dom = fakeEnv({ visible: false });
    let refreshes = 0;
    const sync = startForegroundSync(() => void (refreshes += 1), dom.env);
    dom.online();
    expect(refreshes).toBe(0);
    sync.stop();
  });

  it("stop removes every listener and the timer", () => {
    const dom = fakeEnv();
    const sync = startForegroundSync(() => {}, dom.env);
    expect(dom.listenerCount()).toBeGreaterThan(0);
    sync.stop();
    expect(dom.listenerCount()).toBe(0);
    expect(dom.timers.size).toBe(0);
    expect(sync.active()).toBe(false);
  });
});

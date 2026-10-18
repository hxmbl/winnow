import { describe, expect, it } from "vitest";
import { waitUntilVisible, type VisibilityEnv } from "./visibility";

/** A document whose visibility the test flips by hand, and a clock it runs. */
function fakeEnv(initial: string | undefined) {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial,
    addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
  };
  const timers = new Map<number, () => void>();
  let nextId = 0;
  const env: VisibilityEnv = {
    document: doc,
    setTimeout: (handler) => {
      timers.set(++nextId, handler);
      return nextId;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  return {
    env,
    listeners,
    timers,
    show(state = "visible") {
      doc.visibilityState = state;
      for (const listener of [...listeners]) listener();
    },
    expire() {
      for (const [id, handler] of [...timers]) {
        timers.delete(id);
        handler();
      }
    },
  };
}

describe("waitUntilVisible", () => {
  it("resolves at once when the page is already visible", async () => {
    const { env, listeners } = fakeEnv("visible");
    await expect(waitUntilVisible(1_000, env)).resolves.toBe(true);
    expect(listeners.size).toBe(0);
  });

  it("resolves at once without a document or a visibility state", async () => {
    await expect(waitUntilVisible(1_000, { ...fakeEnv("hidden").env, document: undefined })).resolves.toBe(true);
    await expect(waitUntilVisible(1_000, fakeEnv(undefined).env)).resolves.toBe(true);
  });

  it("waits while hidden and resolves when the app comes back", async () => {
    const fake = fakeEnv("hidden");
    let settled: boolean | null = null;
    const waiting = waitUntilVisible(1_000, fake.env).then((visible) => (settled = visible));

    fake.show("hidden"); // a change that is not "visible" keeps waiting
    await Promise.resolve();
    expect(settled).toBeNull();

    fake.show("visible");
    await waiting;
    expect(settled).toBe(true);
    expect(fake.listeners.size).toBe(0);
    expect(fake.timers.size).toBe(0);
  });

  it("gives up after the timeout so the sign-in still gets its attempt", async () => {
    const fake = fakeEnv("hidden");
    const waiting = waitUntilVisible(1_000, fake.env);
    fake.expire();
    await expect(waiting).resolves.toBe(false);
    expect(fake.listeners.size).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { shownFor, untilFirstMail, type MailStore } from "./firstMail";

type Snap = { accountId: string | null; status: string; all: unknown[] };

function fakeStore(initial: Snap) {
  let snap = initial;
  const listeners = new Set<() => void>();
  const store: MailStore & { set(next: Partial<Snap>): void; listeners: Set<() => void> } = {
    getSnapshot: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      snap = { ...snap, ...next };
      for (const l of [...listeners]) l();
    },
    listeners,
  };
  return store;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("shownFor", () => {
  it("ignores another account's mail, such as the demo's", () => {
    expect(shownFor({ accountId: null, status: "ready", all: [1, 2] }, "a")).toBe(false);
    expect(shownFor({ accountId: "b", status: "ready", all: [1] }, "a")).toBe(false);
  });
  it("counts the first message, a ready inbox, or an error the inbox shows", () => {
    expect(shownFor({ accountId: "a", status: "loading", all: [1] }, "a")).toBe(true);
    expect(shownFor({ accountId: "a", status: "ready", all: [] }, "a")).toBe(true);
    expect(shownFor({ accountId: "a", status: "error", all: [] }, "a")).toBe(true);
    expect(shownFor({ accountId: "a", status: "loading", all: [] }, "a")).toBe(false);
  });
});

describe("untilFirstMail", () => {
  it("resolves when the first message lands, long before the sync finishes", async () => {
    const store = fakeStore({ accountId: null, status: "ready", all: ["demo"] });
    const open = deferred();
    let settled = false;
    void untilFirstMail(store, "a", open.promise).then(() => (settled = true));
    store.set({ accountId: "a", status: "loading", all: [] });
    await tick();
    expect(settled).toBe(false);
    store.set({ all: ["first"] });
    await tick();
    expect(settled).toBe(true);
    expect(store.listeners.size).toBe(0);
    open.resolve();
  });

  it("resolves when the open finishes, even with an empty mailbox", async () => {
    const store = fakeStore({ accountId: "a", status: "loading", all: [] });
    const open = deferred();
    const done = untilFirstMail(store, "a", open.promise);
    open.resolve();
    await expect(done).resolves.toBeUndefined();
  });

  it("rejects when the open fails before anything is shown", async () => {
    const store = fakeStore({ accountId: null, status: "signed_out", all: [] });
    const open = deferred();
    const done = untilFirstMail(store, "a", open.promise);
    open.reject(new Error("boom"));
    await expect(done).rejects.toThrow("boom");
  });

  it("swallows a failure that comes after the mail is on screen", async () => {
    const store = fakeStore({ accountId: "a", status: "loading", all: ["cached"] });
    const open = deferred();
    await expect(untilFirstMail(store, "a", open.promise)).resolves.toBeUndefined();
    open.reject(new Error("late"));
    await tick();
  });
});

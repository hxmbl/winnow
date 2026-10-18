import { describe, expect, it } from "vitest";
import { createIdleWriter, type IdleDeadline, type IdleScheduler } from "./idleWrite";
import { localCache } from "./session";
import type { Email } from "../model/email";

/** A scheduler the test runs by hand: each `run` is one idle slice of `budget` steps. */
function manualScheduler() {
  const queue: Array<(deadline: IdleDeadline) => void> = [];
  const scheduler: IdleScheduler = {
    request: (callback) => {
      queue.push(callback);
      return callback;
    },
    cancel: (handle) => {
      const i = queue.indexOf(handle as (deadline: IdleDeadline) => void);
      if (i >= 0) queue.splice(i, 1);
    },
  };
  /** Run one slice that has room for `steps` chunks (or is overdue). */
  const run = (steps = 1, didTimeout = false) => {
    const callback = queue.shift();
    if (!callback) return false;
    let left = steps;
    callback({ didTimeout, timeRemaining: () => (left-- > 1 ? 10 : 0) });
    return true;
  };
  return { scheduler, run, waiting: () => queue.length };
}

function storage() {
  const map = new Map<string, string>();
  let writes = 0;
  const api = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes += 1;
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
    writes: () => writes,
    get: (k: string) => map.get(k),
  };
  globalThis.localStorage = api as unknown as Storage;
  return api;
}

const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i, text: `row ${from + i}` }));

describe("idle writer", () => {
  it("writes nothing at once, then the whole array across several idle slices", () => {
    const idle = manualScheduler();
    const data = rows(10);
    const commits: string[] = [];
    const writer = createIdleWriter({ rows: () => data, commit: (json) => commits.push(json), scheduler: idle.scheduler, chunkRows: 3 });
    writer.schedule();
    writer.schedule(); // a burst shares one write
    expect(commits).toHaveLength(0);
    expect(idle.waiting()).toBe(1);
    let slices = 0;
    while (idle.run(1)) slices += 1;
    expect(slices).toBe(4); // 3 + 3 + 3 + 1 rows, one chunk per slice
    expect(commits).toHaveLength(1);
    expect(JSON.parse(commits[0]!)).toEqual(data);
    expect(writer.pending()).toBe(false);
  });

  it("an overdue slice finishes the pass in one go", () => {
    const idle = manualScheduler();
    const commits: string[] = [];
    const writer = createIdleWriter({ rows: () => rows(50), commit: (json) => commits.push(json), scheduler: idle.scheduler, chunkRows: 5 });
    writer.schedule();
    idle.run(1, true);
    expect(commits).toHaveLength(1);
    expect(JSON.parse(commits[0]!)).toHaveLength(50);
  });

  it("a change mid-pass restarts it, so what lands is one moment, the latest", () => {
    const idle = manualScheduler();
    let data = rows(9);
    const commits: string[] = [];
    const writer = createIdleWriter({ rows: () => data, commit: (json) => commits.push(json), scheduler: idle.scheduler, chunkRows: 3 });
    writer.schedule();
    idle.run(1);
    data = rows(12, 100);
    writer.schedule();
    while (idle.run(1));
    expect(commits).toHaveLength(1);
    expect(JSON.parse(commits[0]!)).toEqual(data);
    expect(writer._restarts()).toBe(1);
  });

  it("a mailbox that never stops changing still gets written", () => {
    const idle = manualScheduler();
    let n = 30;
    const commits: string[] = [];
    const writer = createIdleWriter({ rows: () => rows(n), commit: (json) => commits.push(json), scheduler: idle.scheduler, chunkRows: 2 });
    writer.schedule();
    for (let i = 0; i < 6 && commits.length === 0; i += 1) {
      idle.run(1);
      n += 1;
      writer.schedule();
    }
    expect(commits.length).toBeGreaterThan(0);
  });

  it("flushNow writes a pending change synchronously and cancels the idle work", () => {
    const idle = manualScheduler();
    const commits: string[] = [];
    const writer = createIdleWriter({ rows: () => rows(4), commit: (json) => commits.push(json), scheduler: idle.scheduler });
    expect(writer.flushNow()).toBe(false);
    writer.schedule();
    expect(writer.flushNow()).toBe(true);
    expect(commits).toHaveLength(1);
    expect(idle.waiting()).toBe(0);
  });
});

describe("the mailbox cache writes in idle time", () => {
  const emails = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ id: from + i, gmailId: `g${from + i}`, receivedAt: 1_000 + from + i, subject: `s${i}` }) as unknown as Email);

  it("an upsert does not touch storage synchronously; idle slices do, once", async () => {
    const store = storage();
    const idle = manualScheduler();
    const cache = localCache("idle", { scheduler: idle.scheduler, lifecycle: () => () => {} });
    await cache.upsert(emails(400));
    await cache.upsert(emails(10, 400));
    expect(store.writes()).toBe(0);
    while (idle.run(2));
    expect(store.writes()).toBe(1);
    expect(JSON.parse(store.get("idle.messages")!)).toHaveLength(410);
  });

  it("leaving the page writes what is pending at once, so nothing is lost", async () => {
    const store = storage();
    const idle = manualScheduler();
    let leave: () => void = () => {};
    const cache = localCache("leave", { scheduler: idle.scheduler, lifecycle: (flushNow) => ((leave = flushNow), () => {}) });
    await cache.upsert(emails(25));
    expect(store.writes()).toBe(0);
    leave();
    expect(store.writes()).toBe(1);
    expect(JSON.parse(store.get("leave.messages")!)).toHaveLength(25);
    expect(idle.run()).toBe(false); // the idle work was cancelled, not run twice
    leave(); // nothing pending: no second write
    expect(store.writes()).toBe(1);
  });

  it("flush() still writes at once and reports the result (the sync engine's cursor rule)", async () => {
    const store = storage();
    const idle = manualScheduler();
    const cache = localCache("flush", { scheduler: idle.scheduler, lifecycle: () => () => {} });
    await cache.upsert(emails(5));
    await cache.flush();
    expect(store.writes()).toBe(1);
    expect(idle.waiting()).toBe(0);
  });

  it("clear() drops a pending write instead of resurrecting the mailbox", async () => {
    const store = storage();
    const idle = manualScheduler();
    const cache = localCache("clear", { scheduler: idle.scheduler, lifecycle: () => () => {} });
    await cache.upsert(emails(5));
    await cache.clear();
    while (idle.run(5));
    expect(store.get("clear.messages")).toBeUndefined();
  });
});

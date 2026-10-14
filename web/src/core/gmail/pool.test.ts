import { describe, expect, it } from "vitest";
import { TaskCancelled, TaskQueue, mapPool } from "./pool";

/** A promise with its resolver outside, so a test decides when work finishes. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("mapPool", () => {
  it("never has more than `concurrency` workers in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(
      Array.from({ length: 50 }, (_, i) => i),
      8,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight -= 1;
      },
    );
    expect(peak).toBe(8);
  });

  it("starts items in list order and returns results in list order", async () => {
    const started: number[] = [];
    const results = await mapPool([5, 4, 3, 2, 1], 2, async (n) => {
      started.push(n);
      await new Promise((resolve) => setTimeout(resolve, n));
      return n * 10;
    });
    expect(started).toEqual([5, 4, 3, 2, 1]);
    expect(results).toEqual([50, 40, 30, 20, 10]);
  });

  it("awaits onResult before a lane takes its next item", async () => {
    const events: string[] = [];
    await mapPool([1, 2], 1, async (n) => {
      events.push(`work ${n}`);
      return n;
    }, async (n) => {
      await tick();
      events.push(`done ${n}`);
    });
    expect(events).toEqual(["work 1", "done 1", "work 2", "done 2"]);
  });

  it("handles an empty list and a silly concurrency", async () => {
    expect(await mapPool([], 8, async () => 1)).toEqual([]);
    expect(await mapPool([1, 2], 0, async (n) => n)).toEqual([1, 2]);
  });

  it("is serial at concurrency 1 — the old engine's behaviour", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool([1, 2, 3], 1, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });
});

describe("TaskQueue", () => {
  it("caps concurrency and runs high priority before queued low priority", async () => {
    const queue = new TaskQueue(1);
    const order: string[] = [];
    const first = deferred();
    const a = queue.push(async () => {
      order.push("low-a");
      await first.promise;
    }, "low");
    const b = queue.push(async () => void order.push("low-b"), "low");
    const c = queue.push(async () => void order.push("high-c"), "high");

    expect(queue.active).toBe(1);
    expect(queue.pending).toBe(2);
    first.resolve();
    await Promise.all([a, b, c]);
    // The running job is not preempted, but the high one overtakes the queued low one.
    expect(order).toEqual(["low-a", "high-c", "low-b"]);
  });

  it("settles each push with its task's value or error", async () => {
    const queue = new TaskQueue(2);
    await expect(queue.push(async () => 42)).resolves.toBe(42);
    await expect(queue.push(async () => {
      throw new Error("nope");
    })).rejects.toThrow("nope");
    // A failure does not wedge the queue.
    await expect(queue.push(async () => "after")).resolves.toBe("after");
  });

  it("clear drops queued work with TaskCancelled and lets running work finish", async () => {
    const queue = new TaskQueue(1);
    const gate = deferred();
    const running = queue.push(async () => {
      await gate.promise;
      return "ran";
    });
    const queued = queue.push(async () => "never");
    queue.clear();
    await expect(queued).rejects.toBeInstanceOf(TaskCancelled);
    gate.resolve();
    await expect(running).resolves.toBe("ran");
  });
});

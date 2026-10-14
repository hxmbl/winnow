/**
 * Bounded concurrency for Gmail requests.
 *
 * Why a pool and not Gmail's batch endpoint (`/batch/gmail/v1`, multipart/mixed):
 *
 *   - Both work from a browser — the batch endpoint answers CORS preflights for any
 *     origin and returns `Access-Control-Allow-Origin` on the multipart response — and
 *     from the desktop webview. So CORS does not decide it.
 *   - Quota does. Gmail charges every request *inside* a batch separately (20 units per
 *     `messages.get`), and the per-user limit of 6,000 units/minute is the ceiling either
 *     way. A batch saves round trips, which a pool of eight on one HTTP/2 connection
 *     already hides.
 *   - A batch fails per part: a 429 on part 17 of 50 needs its own retry, its own
 *     backoff and its own 401 handling, all of which `GmailClient.request` already does
 *     for a single request. A pool reuses that path unchanged.
 *
 * Two shapes:
 *
 *   - `mapPool` — run a list through a worker, at most `concurrency` at a time, in list
 *     order. The sync engine's message fetch.
 *   - `TaskQueue` — a long-lived queue with two priorities, so a body the user just
 *     opened overtakes the background prefetch instead of waiting behind it.
 */

/**
 * Map `items` through `worker` with at most `concurrency` in flight.
 *
 * Items start in order, so the newest mail (which `messages.list` returns first) is
 * requested first. `onResult` runs as each finishes — not in order — and is awaited
 * before that slot takes its next item, which is what keeps a slow consumer (a cache
 * write) from being outrun. A worker that throws rejects the whole map; callers that
 * want per-item failure accounting catch inside the worker, as `sync.ts` does.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onResult?: (result: R, item: T, index: number) => void | Promise<void>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  let next = 0;

  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      const result = await worker(item, index);
      results[index] = result;
      if (onResult) await onResult(result, item, index);
    }
  };

  await Promise.all(Array.from({ length: width }, lane));
  return results;
}

export type Priority = "high" | "low";

type Job = { run: () => Promise<void>; cancel: () => void; priority: Priority };

/** What a job dropped by `TaskQueue.clear` rejects with. */
export class TaskCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "TaskCancelled";
  }
}

/**
 * A queue with a concurrency cap and two priorities.
 *
 * High-priority work starts before any queued low-priority work, but never preempts
 * a job already running — a request on the wire cannot be taken back, and the cap is
 * the point. `clear` drops queued work (a sign-out, a demo switch) and leaves running
 * jobs to finish.
 */
export class TaskQueue {
  private readonly high: Job[] = [];
  private readonly low: Job[] = [];
  private running = 0;

  constructor(private readonly concurrency: number) {}

  /** Queue `task`; the promise settles with it. */
  push<T>(task: () => Promise<T>, priority: Priority = "low"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        priority,
        run: () => task().then(resolve, reject),
        cancel: () => reject(new TaskCancelled()),
      };
      (priority === "high" ? this.high : this.low).push(job);
      this.pump();
    });
  }

  /** How many jobs are waiting (not running). */
  get pending(): number {
    return this.high.length + this.low.length;
  }

  /** How many jobs are on the wire. */
  get active(): number {
    return this.running;
  }

  /** Drop everything not yet started; each dropped job rejects with `TaskCancelled`. */
  clear(): void {
    const dropped = [...this.high, ...this.low];
    this.high.length = 0;
    this.low.length = 0;
    for (const job of dropped) job.cancel();
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const job = this.high.shift() ?? this.low.shift();
      if (!job) return;
      this.running += 1;
      void job.run().finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }
}

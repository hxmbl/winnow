/**
 * Old vs new full sync on a 1,000-message inbox, in simulated time.
 *
 * Every request waits 80ms (a typical round trip to Gmail from Europe) on fake
 * timers, so the suite runs in well under a second while measuring what a user would
 * wait. "Old" is the previous engine's shape: one request at a time, and nothing on
 * screen until the whole sync — every view — had finished. "New" is the pool plus
 * inbox-first publishing.
 *
 * Two scenarios, because they answer different questions:
 *
 *   - **latency only** — how much the pool hides round trips;
 *   - **latency + quota** — the same, with Gmail's per-user quota enforced by the
 *     real `QuotaBucket` (4,800 units/min refill, 1,000 burst, 20 per `messages.get`).
 *     This is the honest number for a first sign-in: quota, not latency, is the
 *     ceiling, so the total barely moves and what changes is how soon the inbox
 *     appears.
 *
 * Set `WINNOW_BENCH_OUT=/path/file.json` to write the numbers out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { GmailSyncEngine } from "./sync";
import { QuotaBucket, UNITS_PER_MINUTE } from "./client";
import { LABEL } from "./dto";
import { fakeMessage, latencyGmail, memoryStore } from "./syncFake";

const LATENCY_MS = 80;
const INBOX = 1_000;
const SENT = 200;
const ARCHIVE = 200;

function mailbox() {
  return [
    ...Array.from({ length: INBOX }, (_, i) => fakeMessage(`i${i}`, [LABEL.inbox], i)),
    ...Array.from({ length: SENT }, (_, i) => fakeMessage(`s${i}`, [LABEL.sent], i)),
    ...Array.from({ length: ARCHIVE }, (_, i) => fakeMessage(`a${i}`, [], i)),
  ];
}

type Run = {
  /** First moment the user has an inbox on screen, ms. */
  firstPaintMs: number;
  /** The whole inbox on screen, ms. */
  inboxCompleteMs: number;
  /** Every view done, ms. */
  totalMs: number;
  requests: number;
};

async function measure(options: { concurrency: number; inboxFirst: boolean; quota: boolean }): Promise<Run> {
  const start = Date.now();
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const bucket = options.quota ? new QuotaBucket(UNITS_PER_MINUTE, () => Date.now(), sleep) : undefined;
  const gmail = latencyGmail({ messages: mailbox(), latencyMs: LATENCY_MS, bucket });
  const store = memoryStore();
  const engine = new GmailSyncEngine({
    client: gmail.client,
    cache: store.cache,
    cursor: store.cursor,
    concurrency: options.concurrency,
  });

  let firstPaint: number | null = null;
  let inboxComplete: number | null = null;
  const onPartial = options.inboxFirst
    ? (emails: { mailbox: string }[]) => {
        const at = Date.now() - start;
        firstPaint ??= at;
        if (inboxComplete === null && emails.filter((email) => email.mailbox === "inbox").length >= INBOX) {
          inboxComplete = at;
        }
      }
    : undefined;

  let done = false;
  const run = engine.full(undefined, onPartial).then((result) => {
    done = true;
    return result;
  });
  while (!done) await vi.advanceTimersToNextTimerAsync();
  const result = await run;
  const total = Date.now() - start;

  expect(result.emails).toHaveLength(INBOX + SENT + ARCHIVE);
  return {
    // The old engine put nothing on screen until it returned.
    firstPaintMs: firstPaint ?? total,
    inboxCompleteMs: inboxComplete ?? total,
    totalMs: total,
    requests: gmail.calls.length,
  };
}

describe("benchmark — full sync of a 1,000-message inbox at 80ms per request", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 14, 12, 0) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("old vs new, with and without Gmail's quota", async () => {
    const results = {
      latencyOnly: {
        old: await measure({ concurrency: 1, inboxFirst: false, quota: false }),
        new: await measure({ concurrency: 8, inboxFirst: true, quota: false }),
      },
      withQuota: {
        old: await measure({ concurrency: 1, inboxFirst: false, quota: true }),
        new: await measure({ concurrency: 8, inboxFirst: true, quota: true }),
      },
    };

    const table = Object.entries(results).flatMap(([scenario, runs]) =>
      Object.entries(runs).map(([engine, run]) => ({
        scenario,
        engine,
        firstPaint: `${(run.firstPaintMs / 1000).toFixed(1)}s`,
        inboxComplete: `${(run.inboxCompleteMs / 1000).toFixed(1)}s`,
        total: `${(run.totalMs / 1000).toFixed(1)}s`,
        requests: run.requests,
      })),
    );
    console.table(table);
    const out = process.env.WINNOW_BENCH_OUT;
    if (out) writeFileSync(out, JSON.stringify(results, null, 2));

    // Latency only: the pool hides round trips — roughly the concurrency factor.
    expect(results.latencyOnly.new.totalMs).toBeLessThan(results.latencyOnly.old.totalMs / 5);
    // First paint is a screenful, not a mailbox.
    expect(results.latencyOnly.new.firstPaintMs).toBeLessThan(1_000);
    expect(results.withQuota.new.firstPaintMs).toBeLessThan(2_000);
    // With quota the totals converge (quota is the ceiling); the inbox still lands first.
    expect(results.withQuota.new.inboxCompleteMs).toBeLessThan(results.withQuota.old.totalMs);
    expect(results.withQuota.new.totalMs).toBeLessThanOrEqual(results.withQuota.old.totalMs * 1.05);
  });
});

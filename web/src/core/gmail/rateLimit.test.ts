/**
 * Quota pacing and rate-limit retries in the request layer.
 *
 * Two of the three behaviours under test are only visible from inside a burst:
 * a sync pages a mailbox back-to-back, and one minute's per-user quota is
 * 6,000 units while a `messages.get` costs 20. The request layer meters what
 * it sends (the pacing) and replays what a retry can fix (the retries).
 * Everything here runs against an injected clock and bucket so the suite is
 * sleep-free; the wall clock only enters through the defaults.
 */

import { describe, expect, it, vi } from "vitest";
import {
  GmailClient,
  MAX_BACKOFF_MS,
  MAX_RETRIES,
  QuotaBucket,
  backoffMs,
  costOf,
  isRateLimited,
  type FetchLike,
  type Sleep,
} from "./client";
import { GmailHttpError } from "./dto";

describe("costOf — the quota units one request spends", () => {
  it("charges the per-method table, and defaults the rest to 5", () => {
    expect(costOf("/users/me/profile", "GET")).toBe(1);
    expect(costOf("/users/me/history?startHistoryId=1", "GET")).toBe(2);
    expect(costOf("/users/me/messages?q=in%3Ainbox&maxResults=200", "GET")).toBe(5);
    expect(costOf("/users/me/drafts?maxResults=50", "GET")).toBe(5);
    expect(costOf("/users/me/messages/m1/modify", "POST")).toBe(5);
    expect(costOf("/users/me/messages/m1?format=full", "GET")).toBe(20);
    expect(costOf("/users/me/drafts/d1?format=full", "GET")).toBe(20);
    expect(costOf("/users/me/messages/m1/attachments/a1", "GET")).toBe(20);
    expect(costOf("/users/me/messages/m1", "DELETE")).toBe(10);
    expect(costOf("/users/me/messages/send", "POST")).toBe(100);
  });
});

describe("isRateLimited — 429 outright, 403 only for quota reasons", () => {
  it("treats every 429 as a rate limit, whatever the body says", () => {
    expect(isRateLimited(429, "")).toBe(true);
    expect(isRateLimited(429, "<html>Too Many Requests</html>")).toBe(true);
  });

  it("reads the quota reasons Google puts in a 403 body", () => {
    for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]) {
      expect(
        isRateLimited(403, JSON.stringify({ error: { errors: [{ reason }] } })),
      ).toBe(true);
    }
    // Some 403s phrase the limit in the message instead of the reasons array.
    expect(
      isRateLimited(403, JSON.stringify({ error: { message: "User Rate Limit Exceeded" } })),
    ).toBe(true);
  });

  it("leaves permissions 403s alone — those do not heal on retry", () => {
    expect(
      isRateLimited(403, JSON.stringify({ error: { errors: [{ reason: "accessNotConfigured" }] } })),
    ).toBe(false);
    expect(isRateLimited(403, "not json")).toBe(false);
    expect(isRateLimited(400, JSON.stringify({ error: { message: "Bad Request" } }))).toBe(false);
    expect(isRateLimited(500, "")).toBe(false);
  });
});

describe("backoffMs — exponential, jittered, capped", () => {
  it("walks 1s, 2s, 4s… with a second of jitter, and stops at the cap", () => {
    // The jitter is [0, 1000), so each attempt's range is disjoint from the
    // next, and the cap dominates from attempt 6 (2^6s + jitter ≥ MAX_BACKOFF_MS).
    const ranges: [number, number][] = [
      [1_000, 2_000],
      [2_000, 3_000],
      [4_000, 5_000],
      [8_000, 9_000],
      [16_000, 17_000],
      [32_000, 33_000],
    ];
    for (let attempt = 0; attempt < ranges.length; attempt += 1) {
      const [low, high] = ranges[attempt];
      expect(backoffMs(attempt)).toBeGreaterThanOrEqual(low);
      expect(backoffMs(attempt)).toBeLessThan(high);
    }
    expect(backoffMs(6)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    expect(backoffMs(20)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });
});

/**
 * A clock that ticks exactly as long as the injected sleep is asked to wait.
 * `take` waits by sleeping, so controlling `sleep` controls the refill; the
 * occasional `advance` stands in for idle time between requests.
 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (async (ms: number) => {
      t += ms;
    }) as Sleep,
    advance: (ms: number) => {
      t += ms;
    },
    ms: () => t,
  };
}

describe("QuotaBucket — the meter", () => {
  // A bucket of 60 units/minute refills one unit per second, which keeps the
  // arithmetic exact: a deficit of `d` units is a wait of `d` seconds.
  const bucket = (clock: ReturnType<typeof fakeClock>) =>
    new QuotaBucket(60, clock.now, clock.sleep);

  it("spends immediately while the burst capacity holds", async () => {
    const clock = fakeClock();
    const b = bucket(clock);
    await b.take(60);
    await expect(b.take(1)).resolves.toBeUndefined(); // waits for one second of refill
    expect(clock.ms()).toBe(1_000);
  });

  it("waits out the refill instead of overdrawing", async () => {
    const clock = fakeClock();
    const b = bucket(clock);
    await b.take(60); // the minute's budget is now spent
    await b.take(20); // twenty units need twenty seconds of refill
    expect(clock.ms()).toBe(20_000);
  });

  it("serialsies concurrent takes so two callers cannot hand each other the same units", async () => {
    const clock = fakeClock();
    const b = bucket(clock);
    const first = b.take(50); // instant: ten units left
    const second = b.take(50); // queued behind the first, waits for forty more
    await Promise.all([first, second]);
    // 60 capacity + 40 refilled = the 100 both took, none borrowed from thin air.
    expect(clock.ms()).toBe(40_000);
  });

  it("caps idle refill at the bucket capacity", async () => {
    const clock = fakeClock();
    const b = bucket(clock);
    await b.take(60); // spent the minute's budget
    clock.advance(120_000); // two idle minutes
    await b.take(60); // refills only to capacity, not to 120
    await b.take(1); // a full refill beyond capacity would make this immediate
    expect(clock.ms()).toBe(121_000);
  });

  it("rejects a cost larger than the bucket capacity", async () => {
    const clock = fakeClock();
    const b = bucket(clock);
    await expect(b.take(61)).rejects.toThrow(RangeError);
    expect(clock.ms()).toBe(0);
  });

  it("empty after a drain, the bucket makes the rest of a burst pace itself", async () => {
    const clock = fakeClock();
    const b = bucket(clock);
    await b.take(30);
    b.drain();
    await b.take(5);
    expect(clock.ms()).toBe(5_000);
  });

  it("never hands out more than it holds", async () => {
    const clock = fakeClock();
    const b = bucket(clock);
    await b.take(60);
    await b.take(7);
    await b.take(3);
    // 60 capacity + 60 seconds of refill == 70 units taken, none served early.
    expect(clock.ms()).toBe(10_000);
  });
});

describe("GmailClient — quota pacing and rate-limit retries", () => {
  type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };
  type Stub = { fetchImpl: FetchLike; calls: Call[] };

  function stubFetch(responses: { status: number; body?: string }[]): Stub {
    const calls: Call[] = [];
    const queue = [...responses];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift() ?? { status: 200, body: "{}" };
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        text: async () => next.body ?? "",
      };
    };
    return { fetchImpl, calls };
  }

  /** A bucket that grants immediately: pacing is exercised in its own tests. */
  const instantBucket = {
    take: async () => {},
    drain: () => {},
  } as unknown as QuotaBucket;
  const noSleep: Sleep = async () => {};

  const client = (
    fetchImpl: FetchLike,
    bucket: QuotaBucket = instantBucket,
    onUnauthorized?: () => Promise<string | null>,
  ) => new GmailClient(async () => "token-1", { fetchImpl, bucket, sleep: noSleep, onUnauthorized });

  it("paces every request through the bucket, charged at the endpoint's cost", async () => {
    const costs: number[] = [];
    const recording = {
      take: async (cost: number) => void costs.push(cost),
      drain: () => {},
    } as unknown as QuotaBucket;
    const { fetchImpl } = stubFetch([{ status: 200 }, { status: 200, body: "{}" }]);
    const gmail = client(fetchImpl, recording);
    await gmail.list("in:inbox", 200);
    await gmail.message("m1");
    expect(costs).toEqual([5, 20]);
  });

  it("retries a 429 after backing off, then returns the follow-up", async () => {
    const drained: string[] = [];
    const observing = {
      take: async () => {},
      drain: () => void drained.push("drained"),
    } as unknown as QuotaBucket;
    const { fetchImpl, calls } = stubFetch([
      { status: 429, body: "Too Many Requests" },
      { status: 200, body: '{"emailAddress":"a@b.c"}' },
    ]);
    const profile = await client(fetchImpl, observing).profile();

    expect(profile.emailAddress).toBe("a@b.c");
    expect(calls).toHaveLength(2);
    expect(drained).toHaveLength(1); // Google already decided: the burst stops now.
  });

  it("gives up on a 429 after MAX_RETRIES and surfaces it as a normal error", async () => {
    const { fetchImpl, calls } = stubFetch(
      Array.from({ length: MAX_RETRIES + 1 }, () => ({
        status: 429,
        body: "Too Many Requests",
      })),
    );
    // A live burst paging an inbox yields a wall of 429s; the error that
    // reaches sync is the last one, complete with its status and body.
    await expect(client(fetchImpl).profile()).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(MAX_RETRIES + 1);
  });

  it("retries a 403 carrying a quota reason, but not one carrying a permission reason", async () => {
    const quota = stubFetch([
      {
        status: 403,
        body: JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }),
      },
      { status: 200, body: '{"emailAddress":"a@b.c"}' },
    ]);
    await expect(client(quota.fetchImpl).profile()).resolves.toMatchObject({ emailAddress: "a@b.c" });
    expect(quota.calls).toHaveLength(2);

    const permission = stubFetch([
      {
        status: 403,
        body: JSON.stringify({ error: { errors: [{ reason: "accessNotConfigured" }] } }),
      },
    ]);
    await expect(client(permission.fetchImpl).profile()).rejects.toThrow(GmailHttpError);
    expect(permission.calls).toHaveLength(1);
  });

  it("still does the single 401 refresh, and lets that replay benefit from the retries", async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 401 },
      { status: 429, body: "Too Many Requests" },
      { status: 200, body: '{"emailAddress":"a@b.c"}' },
    ]);
    const onUnauthorized = vi.fn(async () => "token-2");
    const profile = await client(fetchImpl, instantBucket, onUnauthorized).profile();

    expect(profile.emailAddress).toBe("a@b.c");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
    expect(calls[2].init?.headers?.Authorization).toBe("Bearer token-2");
  });
});
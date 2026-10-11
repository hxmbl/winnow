/**
 * Scale guard rails.
 *
 * Ported in spirit from the Swift suite's `PerformanceTests`, which guarded the pipeline
 * with wall-clock ceilings. Those tests did not survive the React rewrite, and the
 * ~114-message mailbox they measured is the same order as the demo seed, so nothing in CI
 * ran the pipeline at a size a real account reaches. The costs below then accumulated
 * unnoticed:
 *
 *   - a full `derive()` reclassified the entire inbox every 60 seconds, because
 *     `state.now` is part of the state `derive()` is memoised against;
 *   - a full sync upserted the cache every 25 messages, each upsert parsing and
 *     re-serialising the whole mailbox.
 *
 * Two kinds of assertion live here:
 *
 *   - **Work counts**, deterministic and naming the regression exactly: a clock tick must
 *     classify zero messages, so moving `now` back into the memo's key fails on any
 *     machine, under any load.
 *   - **Wall-clock ceilings**, deliberately loose and taking the best of three runs, to
 *     catch an order-of-magnitude regression rather than to benchmark.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { WinnowStore, type MailBackend } from "./store";
import { DEMO_EMAILS } from "../data/demo";
import type { Email } from "../model/email";

/** A mailbox the size a real account reaches, built by cycling the demo seed. */
function synth(n: number): Email[] {
  const out: Email[] = [];
  for (let i = 0; i < n; i += 1) {
    const base = DEMO_EMAILS[i % DEMO_EMAILS.length]!;
    out.push({
      ...base,
      id: i + 1,
      gmailId: `synthetic-${i}`,
      bodyHtml: `<div>${"<p>A message body with enough words in it to be realistic. </p>".repeat(30)}</div>`,
    });
  }
  return out;
}

/**
 * A backend that does nothing.
 *
 * Only its *presence* matters: `startClock` freezes the clock without one, because the
 * demo's fixed instant keeps the seed's day sections deterministic. Reproducing a
 * live-mail regression therefore needs a backend, which is the honest shape of the bug —
 * it only bit people signed in.
 */
const inertBackend: MailBackend = {
  async sync() {
    return { emails: [], failed: 0, truncated: false, cacheUnpersisted: false };
  },
  async toggleStar() {},
  async moveToMailbox() {},
  async setRead() {},
  async deletePermanently() {},
  async sendReply() {},
  async fetchAttachment() {
    return { bytes: new Uint8Array(), filename: "a.bin", mimeType: "application/octet-stream" };
  },
  async fetchBody() {
    return undefined;
  },
};

/** Best of three, so a busy machine cannot make this flaky. */
function timed(iterations: number, body: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    body();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A backend serving `n` messages, each with a distinct HTML body. */
function harness(n: number): { backend: MailBackend } {
  const emails = synth(n).map((email, i) => ({ ...email, bodyHtml: `<p>body ${i}</p>` }));
  return {
    backend: {
      async sync() {
        return { emails, failed: 0, truncated: false, cacheUnpersisted: false };
      },
      async toggleStar() {},
      async moveToMailbox() {},
      async setRead() {},
      async deletePermanently() {},
      async sendReply() {},
      async fetchBody() {
        return undefined;
      },
      async fetchAttachment() {
        return { bytes: new Uint8Array(), filename: "a.bin", mimeType: "application/octet-stream" };
      },
    },
  };
}

describe("scale: a clock tick", () => {
  it("classifies nothing, however big the mailbox", async () => {
    // The regression, named directly: `state.now` advances every 60 seconds to keep
    // relative timestamps and day headings true, which used to invalidate the derived view
    // and reclassify every inbox message — on an idle app, forever. 271ms per tick at
    // 5,000 messages.
    const classify = await import("../classify/classify");
    const spy = vi.spyOn(classify, "classifyAll");

    vi.useFakeTimers();
    const store = new WinnowStore({ seed: synth(2000), backend: inertBackend });
    const stopClock = store.startClock();

    try {
      void store.view; // prime the cache
      const afterPrime = spy.mock.calls.length;
      expect(afterPrime).toBeGreaterThan(0);

      // Ten clock ticks, reading the view after each — what a render does. Reading
      // *matters*: `notify()` only bumps the version, so without a read `derive()` never
      // runs and this test passes even with the memo deleted. A guard rail that cannot
      // fail is not a guard rail.
      for (let i = 0; i < 10; i += 1) {
        vi.advanceTimersByTime(60_000);
        void store.view;
      }

      expect(spy.mock.calls.length - afterPrime).toBe(0);
    } finally {
      stopClock();
    }
  });

  it("still reclassifies when the weights actually move", async () => {
    // The other half of the contract: the memo must not be sticky. A weight change
    // invalidates classification, and a cache that ignored it would silently stop
    // respecting the sliders.
    //
    // Driven through `setSignalWeight` because that is what a slider drag calls.
    // `setWeight` returns a new model with a new `weights` object, the identity the memo
    // keys on; `scheduleReclassify` alone only notifies, and would pass even if the memo
    // ignored weights entirely.
    const classify = await import("../classify/classify");
    const spy = vi.spyOn(classify, "classifyAll");

    const store = new WinnowStore({ seed: synth(500) });
    void store.view;
    const before = spy.mock.calls.length;

    store.setSignalWeight("security", 100);
    // The reclassify is debounced behind the drag, and `notify` only bumps the version —
    // nothing re-derives until a consumer asks for the view, which is what a render does.
    await new Promise((resolve) => setTimeout(resolve, 140));
    void store.view;

    expect(spy.mock.calls.length).toBeGreaterThan(before);
  });
});

describe("scale: the inbox analysis", () => {
  it("a full derive of 5,000 messages stays interactive", () => {
    const store = new WinnowStore({ seed: synth(5000) });
    void store.view; // warm the JIT, so this measures steady state

    // ~271ms for a cold 5,000-message derive before the memo; a ceiling this loose still
    // catches the order-of-magnitude regression while surviving a loaded box.
    const ms = timed(3, () => {
      store.scheduleReclassify();
      void store.view;
    });

    expect(ms).toBeLessThan(150);
  });
});

describe("scale: the view", () => {
  it("derives a large mailbox without collapsing", () => {
    const store = new WinnowStore({ seed: synth(2500) });
    expect(store.view.totalCount).toBeGreaterThan(0);
    expect(store.view.emails.length).toBeGreaterThan(0);
  });
});

describe("scale: resident bodies", () => {
  it("a 5,000-message mailbox holds no HTML on state.all", async () => {
    // The bound itself, at the size it exists for: `BODY_RETENTION` drops the HTML from
    // every message on the way in, so the mailbox in memory is the 33% that is not
    // `bodyHtml`.
    const { backend } = harness(5000);
    const store = new WinnowStore();
    store.attach({ backend });
    await store.connect(backend, { email: "a@b.example" });

    const all = store.getSnapshot().all;
    expect(all.length).toBe(5000);
    expect(all.filter((e) => e.bodyHtml !== undefined)).toHaveLength(0);

    // And the plain text — read by the classifier and the preview line — is all still
    // there: a bound that quietly emptied `body` would pass the check above and break
    // every keyword match on old mail.
    expect(all.filter((e) => e.body.trim() === "")).toHaveLength(0);
  });
});
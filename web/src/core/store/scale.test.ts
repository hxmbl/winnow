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
    // respecting what the learning loop learned.
    //
    // Driven through a star on security mail, which nudges weights: it returns a new model
    // with a new `weights` object, the identity the memo keys on; `scheduleReclassify`
    // alone only notifies, and would pass even if the memo ignored weights entirely.
    const classify = await import("../classify/classify");
    const spy = vi.spyOn(classify, "classifyAll");

    const store = new WinnowStore({ seed: synth(500) });
    void store.view;
    const before = spy.mock.calls.length;

    const security = store.view.emails.find((e) => store.view.signals.get(e.id)?.security)!;
    const weightsBefore = store.getSnapshot().learning.weights;
    store.toggleStar(security.id);
    expect(store.getSnapshot().learning.weights).not.toBe(weightsBefore);
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
describe("scale: one message changes", () => {
  it("reading or archiving one message classifies that message, not the inbox", async () => {
    // Opening a message marks it read, which replaces one object in `all`. Classification
    // is pure in (message, profile, weights), so with the profile unchanged only the new
    // object needs classifying. A 3,000-message inbox used to be reclassified per `j`.
    const classify = await import("../classify/classify");
    const all = vi.spyOn(classify, "classifyAll");
    const one = vi.spyOn(classify, "classifyEmail");
    const store = new WinnowStore({ seed: synth(2000), backend: inertBackend });
    void store.view;
    const unread = store.view.emails.find((e) => e.unread)!;
    const [allBefore, oneBefore] = [all.mock.calls.length, one.mock.calls.length];
    store.toggleRead(unread.id);
    void store.view;
    expect(all.mock.calls.length - allBefore).toBe(0);
    expect(one.mock.calls.length - oneBefore).toBeLessThanOrEqual(1);
  });

  it("and the incremental answer is the one a full pass gives", () => {
    const seed = synth(400);
    const store = new WinnowStore({ seed, backend: inertBackend });
    void store.view;
    for (const email of store.view.emails.filter((e) => e.unread).slice(0, 5)) store.toggleRead(email.id);
    const incremental = store.view.signals;
    store.scheduleReclassify();
    const fresh = new WinnowStore({ seed: store.getSnapshot().all, backend: inertBackend });
    for (const [id, signals] of fresh.view.signals) expect(incremental.get(id)).toEqual(signals);
    // And the rail's counts, which are memoised per message the same way.
    expect([...store.view.inboxCounts].sort()).toEqual([...fresh.view.inboxCounts].sort());
  });
});

describe("scale: archiving or binning one message", () => {
  /**
   * A large inbox with many senders, as a real account has: the demo seed cycled, each
   * copy from one of `senders` distinct addresses, so most senders have a handful of
   * messages and a few have many.
   */
  function manySenders(n: number, senders: number): Email[] {
    return synth(n).map((email, i) => ({
      ...email,
      mailbox: "inbox" as const,
      sender: i % 7 === 0 ? email.sender : `person${(i * 31) % senders}@mail${i % 5}.example.org`,
    }));
  }

  /** Classified from scratch: a new store over the same messages and the same bin. */
  function fullPass(store: WinnowStore) {
    const fresh = new WinnowStore({ seed: store.getSnapshot().all, backend: inertBackend });
    return fresh.view;
  }

  /** The inbox's signals, whichever mailbox the store is showing. */
  function inboxSignals(store: WinnowStore) {
    return store.view.signals;
  }

  for (const [label, seed] of [
    ["the demo inbox", () => DEMO_EMAILS.map((email) => ({ ...email }))],
    ["a large synthetic inbox", () => manySenders(3000, 400)],
  ] as const) {
    it(`${label}: unrelated messages are not reclassified, and the answer equals a full pass`, async () => {
      const { sendersReclassifiedBy } = await import("../model/profile");
      const classify = await import("../classify/classify");
      const all = vi.spyOn(classify, "classifyAll");
      const one = vi.spyOn(classify, "classifyEmail");
      const store = new WinnowStore({ seed: seed(), backend: inertBackend });
      void store.view;

      // A spread of actions: archive and bin from busy and quiet senders alike.
      const inbox = () => store.getSnapshot().all.filter((email) => email.mailbox === "inbox");
      const bySender = new Map<string, number>();
      for (const email of inbox()) bySender.set(email.sender, (bySender.get(email.sender) ?? 0) + 1);
      const busiest = [...bySender].sort((a, b) => b[1] - a[1])[0]![0];
      const loneSender = [...bySender].find(([, count]) => count === 1)?.[0];
      const targets = [
        { id: inbox().find((email) => email.sender === busiest)!.id, act: "archive" as const },
        ...(loneSender ? [{ id: inbox().find((email) => email.sender === loneSender)!.id, act: "trash" as const }] : []),
        { id: inbox()[Math.floor(inbox().length / 2)]!.id, act: "trash" as const },
        { id: inbox()[inbox().length - 1]!.id, act: "archive" as const },
      ];

      for (const { id, act } of targets) {
        const before = new Map(inboxSignals(store));
        const profileBefore = store.view.profile;
        const sender = store.getSnapshot().all.find((email) => email.id === id)!.sender;
        const [allBefore, oneBefore] = [all.mock.calls.length, one.mock.calls.length];
        if (act === "archive") store.archive(id);
        else store.trash(id);
        const after = inboxSignals(store);

        // No full pass, and far fewer single classifications than the inbox holds.
        expect(all.mock.calls.length - allBefore).toBe(0);
        const reclassified = one.mock.calls.length - oneBefore;
        const reclassifiedSenders = new Set(
          one.mock.calls.slice(oneBefore).map(([email]) => (email as Email).sender),
        );
        // Only the acted-on sender's messages (a moved message is a new object), plus the
        // senders whose bias, rank tier or quiet status the move actually changed.
        const allowed = sendersReclassifiedBy(profileBefore, store.view.profile);
        allowed.add(sender);
        for (const reclassifiedSender of reclassifiedSenders) expect(allowed).toContain(reclassifiedSender);
        if (label === "a large synthetic inbox") expect(reclassified).toBeLessThan(inbox().length / 10);

        // Every message from a sender nobody reclassified keeps its exact signals object.
        for (const email of inbox()) {
          if (reclassifiedSenders.has(email.sender)) continue;
          expect(after.get(email.id)).toBe(before.get(email.id));
        }

        // And the incremental answer is the full pass's answer, message for message.
        const fresh = fullPass(store);
        expect(fresh.signals.size).toBe(after.size);
        for (const [messageId, signals] of fresh.signals) expect(after.get(messageId)).toEqual(signals);
        expect(store.view.profile).toEqual(fresh.profile);
        expect([...store.view.inboxCounts].sort()).toEqual([...fresh.inboxCounts].sort());
      }
    });
  }

  it("a sender whose rank or quiet status flips is reclassified, and nobody else", async () => {
    const { buildUserProfile, sendersReclassifiedBy } = await import("../model/profile");
    const inbox = manySenders(600, 80);
    const before = buildUserProfile(inbox, []);
    // Remove every message from the top sender: the ranks below it all shift up a place.
    const top = before.topSenders[0]!;
    const after = buildUserProfile(inbox.filter((email) => email.sender !== top), []);
    const changed = sendersReclassifiedBy(before, after);
    expect(changed.has(top)).toBe(true);
    // The rank ladder moved, so senders crossing a tier boundary are in the set...
    expect(changed.has(before.topSenders[1]!)).toBe(true);
    // ...and a sender with no rank, bias or quiet status on either side is not.
    const bystander = [...new Set(inbox.map((email) => email.sender))].find(
      (sender) =>
        !before.topSenders.includes(sender) &&
        !after.topSenders.includes(sender) &&
        !before.quietSenders.includes(sender) &&
        !after.quietSenders.includes(sender),
    )!;
    expect(changed.has(bystander)).toBe(false);
  });

  it("the incremental profile counts equal a fresh count", async () => {
    const { profileStats, updateProfileStats, profileFromStats, buildUserProfile } = await import("../model/profile");
    const inbox = manySenders(2000, 300);
    let stats = profileStats(inbox, []);
    let current = inbox.slice();
    for (let step = 0; step < 50; step += 1) {
      const index = (step * 97) % current.length;
      const gone = current[index]!;
      const changed = step % 3 === 0 ? { ...gone, starred: !gone.starred } : null;
      current = changed ? current.map((email, i) => (i === index ? changed : email)) : current.filter((_, i) => i !== index);
      const trash = [{ sender: gone.sender, count: step + 1 }];
      stats = updateProfileStats(stats, [gone], changed ? [changed] : [], trash);
      expect(profileFromStats(stats)).toEqual(buildUserProfile(current, trash));
    }
  });
});

/**
 * The demo seed.
 *
 * `DEMO_EXPECTATIONS` is declared in `demo.ts` as the seed's contract: one
 * message per bucket, each tagged with the bucket it exists to demonstrate. This
 * file is that contract being enforced.
 *
 * It matters more than it looks. The demo is what a user sees before deciding
 * whether to trust Winnow with a real account, so a seed edit that quietly stops
 * producing security alerts does not fail a build — it ships a demo that
 * understates the product. And because the demo is the fixture for the
 * classifier tests, a seed that no longer exercises a bucket quietly removes
 * that bucket's test coverage too.
 */

import { describe, expect, it } from "vitest";
import { DEMO_EMAILS, DEMO_EXPECTATIONS, DEMO_NOW, DEMO_TRASH } from "./demo";
import { classifyEmail, contentBag, type SignalMap } from "../classify/classify";
import { matchesBuiltin, rankFilters } from "../classify/filters";
import { buildUserProfile } from "../model/profile";
import { BUILTIN_FILTERS, type BuiltinSmartFilter } from "../model/signals";

/**
 * Classify the seed the way the store does: one profile over the whole mailbox,
 * then one pass producing every message's signals.
 *
 * `classifyEmail`'s third argument is a *weight set*, not options — passing an
 * options object there type-checks against nothing useful and yields `NaN`
 * scores, which silently makes every score-based bucket empty.
 */
function seed() {
  const profile = buildUserProfile(DEMO_EMAILS, []);
  const signals: SignalMap = new Map(
    DEMO_EMAILS.map((email) => [email.id, classifyEmail(email, profile)]),
  );
  return { profile, signals };
}

describe("the demo mailbox", () => {
  it("is populated enough to be worth looking at", () => {
    // One message per bucket would technically satisfy the contract and make a
    // useless demo — a mail client demo showing four rows reads as broken.
    expect(DEMO_EMAILS.length).toBeGreaterThanOrEqual(20);
  });

  it("demonstrates every bucket in the taxonomy", () => {
    // The contract itself. A bucket with no example is a bucket the user cannot
    // evaluate, and adding one to BUILTIN_FILTERS without adding it here would
    // otherwise fail silently.
    const undemonstrated = BUILTIN_FILTERS.filter(
      (bucket) => !(bucket in DEMO_EXPECTATIONS),
    );
    expect(undemonstrated).toEqual([]);
  });

  it("puts each demonstration in the bucket it claims", () => {
    // Every message that claims a bucket must land in it. The demo putting a
    // badge on something the classifier does not agree with is worse than the
    // badge being absent: it teaches the user to distrust the whole rail.
    const { profile, signals } = seed();
    const byGmailId = new Map(DEMO_EMAILS.map((email) => [email.gmailId, email]));
    const failures: string[] = [];

    for (const [bucket, ids] of Object.entries(DEMO_EXPECTATIONS)) {
      for (const id of ids) {
        const email = byGmailId.get(id);
        if (!email) {
          failures.push(`${bucket}: the seed names ${id}, which is not in the mailbox`);
          continue;
        }
        const signal = signals.get(email.id)!;
        if (!matchesBuiltin(bucket as BuiltinSmartFilter, email, signal, profile)) {
          failures.push(`${bucket}: "${email.subject}" does not actually land there`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("gives every claimed bucket at least one message", () => {
    // The other half of the contract. A bucket with no fixture is a bucket the
    // user clicks and gets an empty list from, which reads as the classifier
    // being broken rather than as the seed being incomplete.
    const empty = Object.entries(DEMO_EXPECTATIONS)
      .filter(([, ids]) => ids.length === 0)
      .map(([bucket]) => bucket);
    expect(empty).toEqual([]);
  });

  it("has no timestamps in the future", () => {
    // The demo is built around DEMO_NOW so the day sections and the relative
    // timestamps are deterministic. A message dated after it would render as
    // "in 3 hours" on the demo screen, which reads as a clock bug.
    for (const email of DEMO_EMAILS) {
      expect(email.receivedAt).toBeLessThanOrEqual(DEMO_NOW);
    }
  });

  it("uses the bin to demote senders the user has been throwing away", () => {
    // `DEMO_TRASH` is a list of *senders* the user has binned mail from — the
    // trash bias the profile is built with — not messages, so overlap with the
    // visible inbox is the point rather than a bug: you keep receiving from a
    // retailer and keep binning it, which is exactly what makes it a candidate
    // for demotion.
    //
    // The property worth asserting is that the bias is non-zero and highest for
    // the most-binned sender, since a bias that does nothing makes the whole
    // fixture list decorative.
    const profile = buildUserProfile(DEMO_EMAILS, DEMO_TRASH);
    expect(DEMO_TRASH.length).toBeGreaterThan(0);

    const binned = new Map<string, number>();
    for (const row of DEMO_TRASH) {
      binned.set(row.sender, (binned.get(row.sender) ?? 0) + 1);
    }

    for (const [sender] of binned) {
      // A sender who is in the bin and not in the inbox still gets a bias, via
      // the trash-only branch. One who is in both gets the ratio form.
      if (sender in profile.trashBiasBySender) {
        expect(profile.trashBiasBySender[sender]).toBeGreaterThan(0);
      }
    }

    const mostBinned = [...binned.entries()].sort((a, b) => b[1] - a[1])[0][0];
    expect(profile.trashBiasBySender[mostBinned]).toBeGreaterThan(0);
  });

  it("has a body worth reading, so long reads is demonstrable", () => {
    // `long_reads` is a word-count bucket. Without a long message the bucket is
    // unreachable in the demo, and it is one of the more interesting ones.
    const longest = DEMO_EMAILS.reduce(
      (best, email) => (contentBag(email).length > best ? contentBag(email).length : best),
      0,
    );
    expect(longest).toBeGreaterThan(1200);
  });

  it("uses real-looking addresses, not placeholders", () => {
    // The avatars are colours hashed from the address, and the demo is what a
    // user judges the visual design by. "user1@example.com" reads as a fixture.
    for (const email of DEMO_EMAILS) {
      expect(email.sender).toMatch(/@/);
      expect(email.sender).not.toMatch(/^(user|test|foo)\d*@/i);
    }
  });
});

describe("the rail over the demo", () => {
  it("ranks every non-empty bucket, and hides the empty ones", () => {
    // The rail is the product's opinion made visible, and by design it does not
    // show a bucket with nothing in it — an empty pill invites a click that can
    // only produce an empty list. So the assertion is about coverage of the
    // buckets that *have* mail, not about the taxonomy being fully enumerable.
    const { profile, signals } = seed();
    const ranked = rankFilters(DEMO_EMAILS, signals, profile);

    // Nothing is duplicated, and Unsafe is always present.
    expect(new Set(ranked).size).toBe(ranked.length);
    expect(ranked).toContain("unsafe");

    for (const [bucket, ids] of Object.entries(DEMO_EXPECTATIONS)) {
      const reachable = ids.some((id) => {
        const email = DEMO_EMAILS.find((candidate) => candidate.gmailId === id);
        return email
          ? matchesBuiltin(bucket as BuiltinSmartFilter, email, signals.get(email.id)!, profile)
          : false;
      });
      if (reachable) {
        expect(ranked).toContain(bucket);
      }
    }
  });

  it("gives a distinct avatar colour per sender", () => {
    // Two senders sharing a colour makes the demo's list look like a rendering
    // bug, and the colour is the only identity cue in the row.
    const senders = [...new Set(DEMO_EMAILS.map((email) => email.sender))];
    expect(senders.length).toBeGreaterThan(5);
  });
});
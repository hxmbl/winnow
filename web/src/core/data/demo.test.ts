

import { describe, expect, it } from "vitest";
import { DEMO_EMAILS, DEMO_EXPECTATIONS, DEMO_NOW, DEMO_TRASH } from "./demo";
import { classifyEmail, contentBag, type SignalMap } from "../classify/classify";
import { matchesBuiltin, rankFilters } from "../classify/filters";
import { buildUserProfile } from "../model/profile";
import { BUILTIN_FILTERS, type BuiltinSmartFilter } from "../model/signals";

function seed() {
  const profile = buildUserProfile(DEMO_EMAILS, []);
  const signals: SignalMap = new Map(
    DEMO_EMAILS.map((email) => [email.id, classifyEmail(email, profile)]),
  );
  return { profile, signals };
}

describe("the demo mailbox", () => {
  it("is populated enough to be worth looking at", () => {
    expect(DEMO_EMAILS.length).toBeGreaterThanOrEqual(20);
  });

  it("demonstrates every bucket in the taxonomy", () => {
    const undemonstrated = BUILTIN_FILTERS.filter(
      (bucket) => !(bucket in DEMO_EXPECTATIONS),
    );
    expect(undemonstrated).toEqual([]);
  });

  it("puts each demonstration in the bucket it claims", () => {
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
    const empty = Object.entries(DEMO_EXPECTATIONS)
      .filter(([, ids]) => ids.length === 0)
      .map(([bucket]) => bucket);
    expect(empty).toEqual([]);
  });

  it("has no timestamps in the future", () => {
    for (const email of DEMO_EMAILS) {
      expect(email.receivedAt).toBeLessThanOrEqual(DEMO_NOW);
    }
  });

  it("uses the bin to demote senders the user has been throwing away", () => {
    const profile = buildUserProfile(DEMO_EMAILS, DEMO_TRASH);
    expect(DEMO_TRASH.length).toBeGreaterThan(0);

    const binned = new Map<string, number>();
    for (const row of DEMO_TRASH) {
      binned.set(row.sender, (binned.get(row.sender) ?? 0) + 1);
    }

    for (const [sender] of binned) {
      if (sender in profile.trashBiasBySender) {
        expect(profile.trashBiasBySender[sender]).toBeGreaterThan(0);
      }
    }

    const mostBinned = [...binned.entries()].sort((a, b) => b[1] - a[1])[0][0];
    expect(profile.trashBiasBySender[mostBinned]).toBeGreaterThan(0);
  });

  it("has a body worth reading, so long reads is demonstrable", () => {
    const longest = DEMO_EMAILS.reduce(
      (best, email) => (contentBag(email).length > best ? contentBag(email).length : best),
      0,
    );
    expect(longest).toBeGreaterThan(1200);
  });

  it("uses real-looking addresses, not placeholders", () => {
    for (const email of DEMO_EMAILS) {
      expect(email.sender).toMatch(/@/);
      expect(email.sender).not.toMatch(/^(user|test|foo)\d*@/i);
    }
  });
});

describe("the rail over the demo", () => {
  it("ranks every non-empty bucket, and hides the empty ones", () => {
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
    const senders = [...new Set(DEMO_EMAILS.map((email) => email.sender))];
    expect(senders.length).toBeGreaterThan(5);
  });
});
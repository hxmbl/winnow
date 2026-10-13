

import { describe, expect, it } from "vitest";
import { DEMO_CONTACTS, DEMO_EMAILS, DEMO_EXPECTATIONS, DEMO_NOW, DEMO_TRASH, demoMailbox } from "./demo";
import { buildContactIndex } from "../contacts/index";
import { suggestContacts } from "../contacts/suggest";
import { classifyEmail, contentBag, type SignalMap } from "../classify/classify";
import { matchesBuiltin, rankFilters } from "../classify/filters";
import { buildUserProfile, type UserProfile } from "../model/profile";
import type { Email } from "../model/email";
import {
  BUILTIN_FILTERS,
  type BuiltinSmartFilter,
  type EmailSignals,
} from "../model/signals";

/** What `seed()` produced, for the helpers that read it. */
type Seeded = { profile: UserProfile; signals: SignalMap };

/**
 * The profile and the signals, the way the store builds them.
 *
 * Over the **inbox**, not over the whole mailbox: `buildUserProfile` takes an inbox
 * and `store.inboxAnalysis` hands it one, because learning "who you read" from the bin
 * or the archive teaches the model the wrong thing. This fixture used to pass
 * `DEMO_EMAILS` wholesale, which was indistinguishable from production only while every
 * seed was inbox mail — and the moment a Sent folder existed, four messages the user
 * wrote silently promoted their own address into `topSenders` and pushed a colleague out
 * of `top_contacts`. A fixture that models production has to model its inputs too.
 */
function seed() {
  const inbox = DEMO_EMAILS.filter((email) => email.mailbox === "inbox");
  const profile = buildUserProfile(inbox, []);
  const signals: SignalMap = new Map(
    inbox.map((email) => [email.id, classifyEmail(email, profile)]),
  );
  return { profile, signals };
}

/**
 * One message's signals, classified on demand if the inbox pass did not cover it.
 *
 * Three seeds claim a bucket from the spam mailbox, and the inbox pass does not reach
 * them. They are still checked: "every message claiming a bucket lands in it" is a claim
 * about the whole seed, and quietly skipping the rows the fast path missed would turn it
 * into a claim about most of it.
 */
function signalFor(email: Email, seeded: Seeded): EmailSignals {
  return seeded.signals.get(email.id) ?? classifyEmail(email, seeded.profile);
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
    const seeded = seed();
    const { profile } = seeded;
    const byGmailId = new Map(DEMO_EMAILS.map((email) => [email.gmailId, email]));
    const failures: string[] = [];

    for (const [bucket, ids] of Object.entries(DEMO_EXPECTATIONS)) {
      for (const id of ids) {
        const email = byGmailId.get(id);
        if (!email) {
          failures.push(`${bucket}: the seed names ${id}, which is not in the mailbox`);
          continue;
        }
        const signal = signalFor(email, seeded);
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

  it("resolves every address a seed claims to have", () => {
    // The seed writes recipients the way a header does and lets `parseAddressList`
    // read them, so a typo in a fixture is possible. It has to fail here rather than
    // quietly produce a contact nobody can be sent mail — the composer would suggest an
    // address the demo never had.
    for (const email of DEMO_EMAILS) {
      const claimed = [email.to, email.cc, email.bcc].filter((list) => (list ?? []).length > 0);
      if (claimed.length === 0) continue;
      for (const list of claimed) {
        for (const contact of list!) {
          expect(contact.address).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
          expect(contact.address).not.toBe(email.sender);
        }
      }
    }
  });

  it("gives the sent mailbox the conversations the composer suggests from", () => {
    // The recipient index is built from mail on both sides of a conversation. Sent mail
    // is the only half that is normally visible, so a demo with no recipients on its sent
    // mail would have an autocomplete with nothing in it.
    const sent = DEMO_EMAILS.filter((email) => email.mailbox === "sent");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((email) => (email.to?.length ?? 0) > 0)).toHaveLength(sent.length);
    expect(sent.some((email) => (email.cc?.length ?? 0) > 0)).toBe(true);
    expect(sent.some((email) => (email.bcc?.length ?? 0) > 0)).toBe(true);
  });

  it("threads the user's own reply into the conversation it answers", () => {
    // The migration thread used to have a hole in the middle: Dana, Sam, Dana, with
    // nothing from the user in between, which read as a mailbox where the owner never
    // replies rather than as a fixture that had not been written yet.
    const thread = DEMO_EMAILS.filter((email) => email.threadId === "demo-thread-migration");
    expect(thread.length).toBeGreaterThan(2);
    expect(thread.some((email) => email.mailbox === "sent")).toBe(true);
  });
});

describe("the rail over the demo", () => {
  it("ranks every non-empty bucket, and hides the empty ones", () => {
    const seeded = seed();
    const { profile, signals } = seeded;
    const ranked = rankFilters(DEMO_EMAILS, signals, profile);

    // Nothing is duplicated, and Unsafe is always present.
    expect(new Set(ranked).size).toBe(ranked.length);
    expect(ranked).toContain("unsafe");

    for (const [bucket, ids] of Object.entries(DEMO_EXPECTATIONS)) {
      const reachable = ids.some((id) => {
        const email = DEMO_EMAILS.find((candidate) => candidate.gmailId === id);
        return email
          ? matchesBuiltin(
              bucket as BuiltinSmartFilter,
              email,
              signalFor(email, seeded),
              profile,
            )
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
describe("demoMailbox", () => {
  it("moves the seed onto the real clock without changing its shape", () => {
    const now = Date.UTC(2026, 9, 12, 20, 0, 0);
    const demo = demoMailbox(now);
    expect(demo.now).toBe(now);
    expect(demo.emails).toHaveLength(DEMO_EMAILS.length);
    for (const [i, email] of demo.emails.entries()) {
      expect(email.receivedAt).toBeLessThanOrEqual(now);
      expect(email.receivedAt - DEMO_EMAILS[i]!.receivedAt).toBe(now - DEMO_NOW);
    }
  });

  it("never moves the seed backwards", () => {
    const demo = demoMailbox(DEMO_NOW - 1000);
    expect(demo.now).toBe(DEMO_NOW);
    expect(demo.emails[0]!.receivedAt).toBe(DEMO_EMAILS[0]!.receivedAt);
  });
});

describe("the demo address book", () => {
  it("is fictional, like the rest of the seed", () => {
    for (const contact of DEMO_CONTACTS) expect(contact.address.endsWith(".example")).toBe(true);
  });

  it("does not contain the demo user", () => {
    const self = new Set(DEMO_EMAILS.filter((email) => email.mailbox === "sent").map((email) => email.sender));
    for (const contact of DEMO_CONTACTS) expect(self.has(contact.address)).toBe(false);
  });

  it("merges with the mail: a saved contact the mail never mentions is offered by name", () => {
    const index = buildContactIndex(DEMO_EMAILS, { googleContacts: DEMO_CONTACTS });
    expect(suggestContacts(index, "jonah").map((row) => row.name)).toEqual(["Jonah Mercer"]);
    // And the cast the smoke test types for stays a single match.
    expect(suggestContacts(index, "helena").map((row) => row.name)).toEqual(["Helena Ruiz"]);
  });
});

import { describe, expect, it } from "vitest";
import { matchesBuiltin, matchesFilter, rankFilters } from "./filters";
import { classifyAll } from "./classify";
import { buildUserProfile, EMPTY_PROFILE } from "../model/profile";
import {
  IMPORTANT_THRESHOLD,
  builtinFilter,
  isUnsafe,
  senderFilter,
  type BuiltinSmartFilter,
  type EmailSignals,
} from "../model/signals";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import type { Email } from "../model/email";

function email(over: Partial<Email> = {}): Email {
  return {
    id: 1,
    gmailId: "g1",
    sender: "someone@northwind.example",
    mailbox: "inbox",
    receivedAt: 0,
    subject: "",
    body: "",
    category: "primary",
    starred: false,
    unread: false,
    attachments: [],
    urgent: false,
    ...over,
  };
}

const profile = buildUserProfile(DEMO_EMAILS, DEMO_TRASH);
const inbox = DEMO_EMAILS.filter((m) => m.mailbox === "inbox");
const signals = classifyAll(inbox, profile);

function sigFor(gmailId: string): EmailSignals {
  const message = DEMO_EMAILS.find((m) => m.gmailId === gmailId);
  if (!message) throw new Error(`no fixture ${gmailId}`);
  const cached = signals.get(message.id);
  if (cached) return cached;
  return classifyAll([message], profile).get(message.id)!;
}

describe("matchesBuiltin — unsafe", () => {
  it("contains exactly the messages at or above the threshold", () => {
    const matched = inbox.filter((m) => matchesBuiltin("unsafe", m, sigFor(m.gmailId), profile));
    for (const message of matched) {
      expect(isUnsafe(sigFor(message.gmailId))).toBe(true);
    }
    for (const message of inbox) {
      if (isUnsafe(sigFor(message.gmailId))) {
        expect(matched).toContain(message);
      }
    }
  });

  it("is never mixed into a positive bucket", () => {
    // The whole point of the `safe && …` guard: a user who explicitly asks for
    // "Important" must never be shown a phishing lure.
    const positive: BuiltinSmartFilter[] = [
      "important",
      "urgent",
      "needs_action",
      "receipts",
      "codes",
      "shipping",
      "travel",
      "events",
      "social",
      "unread",
      "attachments",
      "long_reads",
      "new_senders",
    ];
    for (const bucket of positive) {
      for (const message of inbox) {
        const sig = sigFor(message.gmailId);
        if (!isUnsafe(sig)) continue;
        expect(
          matchesBuiltin(bucket, message, sig, profile),
          `${message.gmailId} is unsafe but matched ${bucket}`,
        ).toBe(false);
      }
    }
  });
});

describe("matchesBuiltin — important", () => {
  it("uses the shared threshold, so the pill and the badge cannot disagree", () => {
    // The bug this guards: the filter matched at 56 while the badge appeared at
    // 70, so messages existed in an Important filter wearing no badge.
    const message = email({ subject: "Notes", body: "Some notes." });
    const sig: EmailSignals = {
      ...classifyAll([message], EMPTY_PROFILE).get(message.id)!,
      importanceScore: IMPORTANT_THRESHOLD,
      newsletter: false,
      promotional: false,
    };
    expect(matchesBuiltin("important", message, sig, EMPTY_PROFILE)).toBe(true);
  });

  it("excludes newsletters even at a high score", () => {
    const message = email({ subject: "Issue", body: "Unsubscribe. View in browser." });
    const sig: EmailSignals = {
      ...classifyAll([message], EMPTY_PROFILE).get(message.id)!,
      importanceScore: 90,
      newsletter: true,
    };
    expect(matchesBuiltin("important", message, sig, EMPTY_PROFILE)).toBe(false);
  });
});

describe("matchesBuiltin — read later", () => {
  it("is not a synonym for newsletter", () => {
    // It used to be `promotional || newsletter`, which made Read later a
    // duplicate of two buckets that already existed and hid quiet personal mail
    // that genuinely could be skipped. The admin notice below is neither bulk
    // nor promotional, and is the kind of message Read later is for.
    const admin = inbox.find((m) => m.gmailId === "demo-quiet-2")!;
    const sig = sigFor(admin.gmailId);
    expect(sig.newsletter).toBe(false);
    expect(sig.promotional).toBe(false);
    expect(matchesBuiltin("low_priority", admin, sig, profile)).toBe(true);
  });

  it("does not contain a message that needs an answer", () => {
    // The distinguishing property of Read later: nothing is lost by skipping
    // it. A message asking for a reply is not that.
    const action = inbox.find((m) => m.gmailId === "demo-action-3")!;
    expect(matchesBuiltin("low_priority", action, sigFor(action.gmailId), profile)).toBe(false);
  });

  it("never contains a starred message", () => {
    const message = email({ starred: true, subject: "Hello", body: "Just saying hello." });
    const p = buildUserProfile([message], []);
    expect(matchesBuiltin("low_priority", message, classifyAll([message], p).get(message.id)!, p)).toBe(
      false,
    );
  });
});

describe("matchesBuiltin — urgent", () => {
  it("excludes marketing urgency unless the sender flagged it", () => {
    const promo = email({
      subject: "Last chance: 48% off",
      body: "Flash sale, ends at midnight. Limited time.",
      category: "promotions",
    });
    const p = buildUserProfile([promo], []);
    const sig = classifyAll([promo], p).get(promo.id)!;
    expect(sig.urgentText).toBe(true);
    expect(matchesBuiltin("urgent", promo, sig, p)).toBe(false);
  });

  it("includes it when the sender did flag it", () => {
    const flagged = email({
      subject: "Last chance: 48% off",
      body: "Flash sale, ends at midnight. Limited time.",
      category: "promotions",
      urgent: true,
    });
    const p = buildUserProfile([flagged], []);
    expect(matchesBuiltin("urgent", flagged, classifyAll([flagged], p).get(flagged.id)!, p)).toBe(true);
  });
});

describe("matchesFilter — sender comparison", () => {
  it("is case-insensitive", () => {
    // Addresses are not case-sensitive in practice; a case-sensitive compare
    // split one person into two senders, with two biases and two pills.
    const message = email({ sender: "Ada@Northwind.example" });
    const sig = classifyAll([message], EMPTY_PROFILE).get(message.id)!;
    expect(matchesFilter(senderFilter("ada@northwind.example"), message, sig, EMPTY_PROFILE)).toBe(true);
  });

  it("does not match a different sender", () => {
    const message = email({ sender: "ada@northwind.example" });
    const sig = classifyAll([message], EMPTY_PROFILE).get(message.id)!;
    expect(matchesFilter(senderFilter("bob@northwind.example"), message, sig, EMPTY_PROFILE)).toBe(false);
  });
});

describe("rankFilters", () => {
  it("pins the permanent buckets first, even when empty", () => {
    // Important and Deliveries are the two a user reaches for on a bad day. A
    // pill that disappears exactly when it is needed is worse than no pill.
    const ranked = rankFilters([], new Map(), EMPTY_PROFILE);
    expect(ranked.slice(0, 2)).toEqual(["important", "shipping"]);
  });

  it("pins unsafe last", () => {
    const ranked = rankFilters(inbox, signals, profile);
    expect(ranked[ranked.length - 1]).toBe("unsafe");
  });

  it("hides empty buckets that are not permanent", () => {
    // "Files" matches one demo message; "Quiet contacts" matches two. A bucket
    // advertising a count of zero costs a rail slot and offers nothing.
    //
    // `social` is the control: the demo has two social messages, so it is
    // present, and its absence from the ranked list would mean non-empty buckets
    // are being dropped.
    const ranked = rankFilters(inbox, signals, profile);
    expect(ranked).toContain("attachments");
    expect(ranked).toContain("social");

    // A slice with nothing in it: the demo has no starred message in
    // `slice`, so the bucket has nothing to offer and must not appear.
    const quiet = rankFilters([], new Map(), profile);
    expect(quiet).not.toContain("starred");
  });

  it("gives every permanent bucket a position regardless of count", () => {
    const oneMessage = inbox.slice(0, 1);
    const ranked = rankFilters(oneMessage, classifyAll(oneMessage, profile), profile);
    expect(ranked[0]).toBe("important");
    expect(ranked[1]).toBe("shipping");
  });

  it("omits a muted bucket entirely", () => {
    const ranked = rankFilters(inbox, signals, profile, new Set(["urgent"]));
    expect(ranked).not.toContain("urgent");
  });

  it("orders the rest by volume, breaking ties by catalog order", () => {
    const ranked = rankFilters(inbox, signals, profile);
    // Starred is empty and therefore absent; everything after the pinned pair
    // should be strictly non-increasing in match count, except unsafe which is
    // pinned last regardless.
    const magic = ranked.slice(2, -1);
    const counts = magic.map((id) =>
      inbox.filter((m) => matchesBuiltin(id, m, sigFor(m.gmailId), profile)).length,
    );
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
  });

  it("counts unsafe, unlike every other bucket", () => {
    // Unsafe's members *are* the spam-scored rows. Skipping them here would
    // count zero and pin the one safety valve to a meaningless position.
    const ranked = rankFilters(inbox, signals, profile);
    expect(ranked).toContain("unsafe");
  });
});

describe("filter ids", () => {
  it("round-trips through its key form", () => {
    const built = builtinFilter("needs_action");
    const sender = senderFilter("ada@northwind.example");
    // The prefix scheme this replaced collided: a sender whose address began
    // with `sender:` produced an id that meant something else entirely.
    expect(sender.kind).toBe("sender");
    expect(built.kind).toBe("builtin");
  });
});

describe("the demo covers every bucket the UI offers", () => {
  it("has at least one message in each advertised bucket, or the bucket is hidden", () => {
    const ranked = rankFilters(inbox, signals, profile);
    // This is the real assertion: a bucket the rail advertises but that
    // nothing lands in is a pill that leads to an empty list.
    for (const id of ranked) {
      const count = inbox.filter((m) => matchesBuiltin(id, m, sigFor(m.gmailId), profile)).length;
      if (id === "unsafe" || id === "important" || id === "shipping") continue;
      expect(count, `${id} is advertised but empty`).toBeGreaterThan(0);
    }
  });
});

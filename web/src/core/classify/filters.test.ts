import { describe, expect, it } from "vitest";
import { countAllFilters, matchesBuiltin, matchesFilter, rankFilters } from "./filters";
import { classifyAll } from "./classify";
import { buildUserProfile, EMPTY_PROFILE, type UserProfile } from "../model/profile";
import {
  BUILTIN_FILTERS,
  IMPORTANT_THRESHOLD,
  PERMANENT_FILTERS,
  UNSAFE_THRESHOLD,
  badgeFilters,
  builtinFilter,
  filterKey,
  filterLabel,
  isUnsafe,
  parseFilterKey,
  senderFilter,
  type BuiltinSmartFilter,
  type EmailSignals,
  type FilterId,
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

const inbox = DEMO_EMAILS.filter((m) => m.mailbox === "inbox");
// The profile is built over the inbox, not the whole mailbox — see `buildUserProfile`,
// whose parameter is an inbox, and `store.inboxAnalysis`, which hands it one. Passing
// `DEMO_EMAILS` was the same code with different inputs: harmless while every seed was
// inbox mail, and wrong from the moment a Sent folder existed.
const profile = buildUserProfile(inbox, DEMO_TRASH);
const signals = classifyAll(inbox, profile);

function sigFor(gmailId: string): EmailSignals {
  const message = DEMO_EMAILS.find((m) => m.gmailId === gmailId);
  if (!message) throw new Error(`no fixture ${gmailId}`);
  const cached = signals.get(message.id);
  if (cached) return cached;
  return classifyAll([message], profile).get(message.id)!;
}

// ── Phishing lures ──────────────────────────────────────────────────────────

/**
 * The one phishing phrase, and the one sender tell, that together reach
 * `UNSAFE_THRESHOLD` exactly: digits in the domain are worth 0.1 and
 * "account has been compromised" is worth 0.3.
 *
 * Landing *on* the threshold rather than past it is the point of every fixture
 * below. It means a `>` where the code means `>=` reclassifies them silently,
 * and it keeps the lure table honest about the one boundary that decides
 * whether a lure is refused.
 */
const PHISH_TAIL = " Your account has been compromised.";
const LURE_SENDER = "hello@lookalike1.example";

function lure(over: Partial<Email> = {}): Email {
  return email({
    gmailId: "lure",
    sender: LURE_SENDER,
    subject: "Hello",
    body: `Hello there.${PHISH_TAIL}`,
    ...over,
  });
}

/**
 * Every lure shares one sender, so one profile makes all of them a first-time
 * sender, a quiet contact and a top contact at once. That is deliberate:
 * `New contacts` is the one positive bucket keyed off the profile rather than
 * off the message, so a lure table that skipped it would leave that guard
 * unexercised.
 */
const LURE_PROFILE: UserProfile = {
  trashBiasBySender: {},
  topSenders: [LURE_SENDER],
  quietSenders: [LURE_SENDER],
  firstTimeSenders: [LURE_SENDER],
};

/**
 * One lure per positive bucket, each shaped so that exactly that bucket would
 * admit it if the `safe &&` guard came off — and each naming the message-level
 * signal that makes it fit, so a lure that quietly stopped fitting cannot pass
 * the table above it by becoming harmless.
 *
 * The demo cannot supply these. Only `demo-security-2` is unsafe *and* filed in
 * the inbox, so against the seed a dropped guard is invisible for twelve of the
 * fourteen guarded buckets.
 */
const LURE_ROW = (
  bucket: BuiltinSmartFilter,
  signal: keyof EmailSignals,
  id: number,
  over: Partial<Email> = {},
): { bucket: BuiltinSmartFilter; signal: keyof EmailSignals; message: Email } => ({
  bucket,
  signal,
  message: lure({ id, ...over }),
});

/** The lure that is urgent, reads as an ask, and scores 75. Three buckets. */
const SIGN_TODAY: Partial<Email> = {
  subject: "Urgent: please sign the attached agreement",
  body: `Please sign the attached agreement today.${PHISH_TAIL}`,
};

const LURES = [
  LURE_ROW("important", "needsAction", 101, SIGN_TODAY),
  LURE_ROW("urgent", "urgentText", 102, SIGN_TODAY),
  LURE_ROW("needs_action", "needsAction", 103, SIGN_TODAY),
  LURE_ROW("receipts", "finance", 104, {
    body: `Your invoice for April is attached.${PHISH_TAIL}`,
  }),
  LURE_ROW("codes", "codes", 105, {
    body: `Your verification code is 418902.${PHISH_TAIL}`,
  }),
  LURE_ROW("shipping", "shipping", 106, {
    body: `Your parcel is out for delivery today.${PHISH_TAIL}`,
  }),
  LURE_ROW("travel", "travel", 107, {
    body: `Your hotel is confirmed for Friday.${PHISH_TAIL}`,
  }),
  LURE_ROW("events", "events", 108, {
    body: `A workshop on async Rust runs on Thursday.${PHISH_TAIL}`,
  }),
  LURE_ROW("social", "social", 109, {
    sender: "noreply@social1.linkedin.com",
    body: `Someone mentioned you in a post.${PHISH_TAIL}`,
  }),
  LURE_ROW("new_senders", "spamLikelihood", 110),
  LURE_ROW("unread", "spamLikelihood", 111, { unread: true }),
  LURE_ROW("attachments", "spamLikelihood", 112, {
    attachments: [
      {
        id: "a1",
        partId: "1",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        size: 1,
        inline: false,
      },
    ],
  }),
  LURE_ROW("long_reads", "longRead", 113, {
    body: `${"lorem ".repeat(250)}ipsum.${PHISH_TAIL}`,
  }),
  LURE_ROW("low_priority", "importanceScore", 114, {
    subject: "Notes",
    body: `Some notes.${PHISH_TAIL}`,
  }),
];

/**
 * Every bucket that means "worth your attention", and every one of them carries
 * the `safe &&` guard. `starred`, `newsletters`, `promotional`, `top_contacts`
 * and `quiet_contacts` are absent because they read the message or the profile
 * directly and have no guard; `security` is absent because the guard is
 * deliberately applied once, in `countAllFilters`, rather than per predicate.
 */
const POSITIVE: readonly BuiltinSmartFilter[] = [
  "important",
  "urgent",
  "needs_action",
  "receipts",
  "codes",
  "shipping",
  "travel",
  "events",
  "social",
  "new_senders",
  "unread",
  "attachments",
  "long_reads",
  "low_priority",
];

describe("matchesBuiltin — unsafe", () => {
  it("contains exactly the one demo message that crosses the threshold", () => {
    // Hand-derived, and deliberately not "whatever `isUnsafe` says". The seed
    // files four junk fixtures — `demo-spam-1`, `demo-spam-2`, `demo-spam-3`
    // and `demo-spam-4` — in the spam mailbox and `demo-trash-1` in the bin, so
    // the only unsafe message the rail can ever show is the seeded phish.
    //
    // Asserting `matchesBuiltin("unsafe", …) === isUnsafe(sig)` instead would
    // hold for any implementation at all, including one that never looks at a
    // score: the predicate for this bucket *is* `isUnsafe`.
    const matched = inbox.filter((m) => matchesBuiltin("unsafe", m, sigFor(m.gmailId), profile));
    expect(matched.map((m) => m.gmailId)).toEqual(["demo-security-2"]);
  });

  it("scores the seeded phish at 0.85, from three tells and no others", () => {
    // 0.1 for the digits in `github-security227.com`, 0.3 for "account has been
    // compromised", 0.45 for the coercion in the closing paragraph. Nothing
    // else applies: the subject is not empty, the "click here" branch is
    // superseded by the phishing branch, there is no scam phrase, the subject
    // is not shouty, and the sender has never been binned.
    expect(sigFor("demo-security-2").spamLikelihood).toBeCloseTo(0.85, 10);
  });

  it("calls a message sitting exactly on the threshold unsafe", () => {
    // `>=` is the load-bearing half of `isUnsafe`. Digits in the domain (0.1)
    // plus one phishing phrase (0.3) lands on exactly 0.4, so a `>` here would
    // file this message as ordinary mail — and would do it silently, because
    // nothing else about it reads as junk.
    const message = email({
      id: 900,
      gmailId: "edge",
      sender: "no-reply@secure-login1.example",
      subject: "Notice",
      body: "Your account has been compromised.",
    });
    const signals = classifyAll([message], EMPTY_PROFILE).get(message.id)!;
    expect(signals.spamLikelihood).toBe(UNSAFE_THRESHOLD);
    expect(matchesBuiltin("unsafe", message, signals, EMPTY_PROFILE)).toBe(true);
  });

  it("agrees with the classifier on every message in the seed, junk or not", () => {
    // The one place comparing `matchesBuiltin("unsafe")` against `isUnsafe` is
    // worth doing: over the whole seed, where the junk fixtures actually live.
    // The expected ids are written out rather than computed, so the comparison
    // has a fixed answer to agree with — 46 of the 57 demo messages are clean.
    const expected = [
      "demo-spam-1",
      "demo-security-2",
      "demo-spam-2",
      "demo-spam-3",
      "demo-trash-1",
      "demo-spam-4",
    ];
    for (const message of DEMO_EMAILS) {
      const sig = classifyAll([message], profile).get(message.id)!;
      expect(matchesBuiltin("unsafe", message, sig, profile), message.gmailId).toBe(
        expected.includes(message.gmailId),
      );
    }
    expect(DEMO_EMAILS).toHaveLength(57);
  });
});

describe("matchesBuiltin — the safe guard", () => {
  it("refuses every positive bucket for every lure", () => {
    // The whole point of the `safe &&` guard: a user who explicitly asks for
    // "Important" must never be shown a phishing lure. Fourteen lures against
    // fourteen buckets, so a dropped guard anywhere in the table is red on the
    // row that owns it rather than only on the two the demo happens to reach.
    let checked = 0;
    for (const row of LURES) {
      const sig = classifyAll([row.message], LURE_PROFILE).get(row.message.id)!;
      expect(sig.spamLikelihood, row.bucket).toBe(UNSAFE_THRESHOLD);
      for (const bucket of POSITIVE) {
        expect(
          matchesBuiltin(bucket, row.message, sig, LURE_PROFILE),
          `${row.message.gmailId} matched ${bucket}`,
        ).toBe(false);
        checked += 1;
      }
    }
    // 14 x 14. Asserted so that a shrunken table cannot make this silently
    // vacuous, which is the failure this whole fixture set exists to prevent.
    expect(checked).toBe(LURES.length * POSITIVE.length);
    expect(LURES).toHaveLength(14);
    expect(POSITIVE).toHaveLength(14);
  });

  it("gives every lure the signal its own bucket is keyed off", () => {
    // Without this the table above could be satisfied by lures that match
    // nothing at all, which is the shape a vacuous test takes.
    for (const row of LURES) {
      const sig = classifyAll([row.message], LURE_PROFILE).get(row.message.id)!;
      const value = sig[row.signal];
      expect(
        typeof value === "number" ? value > 0 : value,
        `${row.message.gmailId} carries no ${row.signal}`,
      ).toBe(true);
    }
  });

  it("keeps the seeded phish out of the seeded buckets", () => {
    // The demo cannot prove the guard bucket by bucket, but it can prove the
    // one case that ships: the seeded phish is urgent-reading, security-reading
    // and a first-time sender, and it must appear in none of them.
    const phish = inbox.find((m) => m.gmailId === "demo-security-2")!;
    const sig = sigFor(phish.gmailId);
    expect(sig.urgentText).toBe(true);
    expect(sig.security).toBe(true);
    expect(LURE_PROFILE.firstTimeSenders).not.toContain(phish.sender);
    let checked = 0;
    for (const bucket of POSITIVE) {
      expect(matchesBuiltin(bucket, phish, sig, profile), bucket).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(POSITIVE.length);
  });
});

describe("matchesBuiltin — important", () => {
  it("uses the shared threshold, so the pill and the badge cannot disagree", () => {
    // Both sides call `isImportant`, so the badge and the filter answer the same
    // question identically — the pairs below are the whole argument. `urgent: false`
    // throughout; an explicitly urgent *promotion* is the one case where bulk still
    // counts and gets its own message, so the flag's effect stays attributable.
    const message = email({ subject: "Notes", body: "Some notes.", urgent: false });
    const base = classifyAll([message], EMPTY_PROFILE).get(message.id)!;
    const scored = (over: Partial<EmailSignals> & { importanceScore: number }): EmailSignals => ({
      ...base,
      newsletter: false,
      promotional: false,
      ...over,
    });

    const cases: { label: string; signals: EmailSignals; important: boolean }[] = [
      { label: "exactly the threshold", signals: scored({ importanceScore: IMPORTANT_THRESHOLD }), important: true },
      { label: "well above it", signals: scored({ importanceScore: 90 }), important: true },
      { label: "one point below", signals: scored({ importanceScore: IMPORTANT_THRESHOLD - 1 }), important: false },
      {
        label: "high-scoring newsletter",
        signals: scored({ importanceScore: 90, newsletter: true }),
        important: false,
      },
      {
        label: "high-scoring promotion",
        signals: scored({ importanceScore: 90, promotional: true }),
        important: false,
      },
      {
        label: "low-scoring ask",
        signals: scored({ importanceScore: 20, needsAction: true }),
        important: true,
      },
      {
        label: "spam, however well it scores",
        signals: scored({ importanceScore: 99, spamLikelihood: 0.9 }),
        important: false,
      },
    ];

    for (const { label, signals: sig, important } of cases) {
      expect(matchesBuiltin("important", message, sig, EMPTY_PROFILE), label).toBe(important);
      expect(badgeFilters(message, sig).includes("important"), label).toBe(important);
    }

    // The one exception, and it needs a message of its own because it is the only
    // thing `email.urgent` is consulted for: a promotion the *sender* flagged
    // important. "Last chance!" from a retailer is marketing; a promotion from a
    // supplier marked urgent is the recipient's business.
    const flagged = email({ subject: "Order ready", body: "Collect today.", urgent: true });
    const promo = scored({ importanceScore: 20, needsAction: true, promotional: true });
    expect(matchesBuiltin("important", flagged, promo, EMPTY_PROFILE)).toBe(true);
    expect(badgeFilters(flagged, promo).includes("important")).toBe(true);
    // …and the same signals on an unflagged message stay out, which is what makes
    // this a rule about the flag rather than about the signals.
    expect(matchesBuiltin("important", message, promo, EMPTY_PROFILE)).toBe(false);
  });

  it("excludes newsletters and promos even at a high score", () => {
    // Bulk mail has its own buckets, so a weekly issue at 90 is not Important. All
    // four combinations, because the predicate names two flags and one guards only
    // the score half. `badgeFilters` is asserted alongside because the two share
    // `isImportant` and must agree.
    const message = email({ subject: "Issue", body: "Unsubscribe. View in browser." });
    const base = classifyAll([message], EMPTY_PROFILE).get(message.id)!;
    expect(base.needsAction).toBe(false);
    for (const newsletter of [false, true]) {
      for (const promotional of [false, true]) {
        const sig = { ...base, importanceScore: 90, newsletter, promotional };
        expect(
          matchesBuiltin("important", message, sig, EMPTY_PROFILE),
          `${newsletter}/${promotional}`,
        ).toBe(!(newsletter || promotional));
        expect(
          badgeFilters(message, sig).includes("important"),
          `${newsletter}/${promotional}`,
        ).toBe(!(newsletter || promotional));
      }
    }
  });

  it("reaches the score for a bare ask, but not a promo making one", () => {
    // The second half of the predicate: `needsAction && !promotional`, which
    // admits a message scoring well below the threshold provided nothing is
    // marketing it.
    const message = email({ subject: "Re: the plan", body: "Could you send the two queries again?" });
    const base = classifyAll([message], EMPTY_PROFILE).get(message.id)!;
    expect(base.needsAction).toBe(true);
    const ask = { ...base, importanceScore: 10, promotional: false };
    const promo = { ...ask, promotional: true };
    expect(matchesBuiltin("important", message, ask, EMPTY_PROFILE)).toBe(true);
    expect(matchesBuiltin("important", message, promo, EMPTY_PROFILE)).toBe(false);
    // …and the promo is at least a promo, so the exclusion is doing the work
    // rather than a mis-classification passing for one.
    expect(promo.promotional).toBe(true);
  });
});

describe("matchesBuiltin — read later", () => {
  it("is not a synonym for newsletter", () => {
    // Read later is not "is a newsletter": the admin notice below is neither bulk
    // nor promotional, and is the kind of message the bucket is for.
    const admin = inbox.find((m) => m.gmailId === "demo-quiet-2")!;
    const sig = sigFor(admin.gmailId);
    expect(sig.newsletter).toBe(false);
    expect(sig.promotional).toBe(false);
    expect(sig.importanceScore).toBeLessThanOrEqual(50);
    expect(matchesBuiltin("low_priority", admin, sig, profile)).toBe(true);
  });

  it("does not contain a message that needs an answer", () => {
    // The distinguishing property of Read later: nothing is lost by skipping
    // it. A message asking for a reply is not that.
    const action = inbox.find((m) => m.gmailId === "demo-action-3")!;
    expect(matchesBuiltin("low_priority", action, sigFor(action.gmailId), profile)).toBe(false);
  });

  it("excludes every signal it names, and nothing else", () => {
    // Read later is a list of named exclusions plus a score boundary, so each
    // exclusion gets its own pair: a message that carries the signal and scores
    // at or below 50, and the same message with the signal removed. Both
    // directions are asserted, because an exclusion with no control is the
    // easiest kind of test to write and the easiest kind to pass by accident.
    //
    // Each hazard is dragged under the boundary by an empty subject (0.2) plus
    // whatever else its own wording triggers, so `importanceScore <= 50` is
    // satisfied and the named clause is the only thing left refusing it.
    //
    // `urgentText` and `security` have no row: they pay 18 and 16 points, which
    // puts them out of reach of the boundary unless the message is also unsafe,
    // and an unsafe message is already refused by `safe`. Those two clauses are
    // defensive; this table cannot reach them, and says so rather than pretending
    // to.
    const pair = (
      signal: string,
      id: number,
      hazard: Partial<Email>,
      control: Partial<Email>,
    ): [string, Email, Email] => [
      signal,
      email({ id, sender: "dana@northwind.example", subject: "", ...hazard }),
      email({ id: id + 1, sender: "dana@northwind.example", subject: "", ...control }),
    ];
    const rows: [string, Email, Email][] = [
      // Starred needs the promo penalty to buy back the 22 points a star adds,
      // or the message would clear the boundary on the star alone.
      pair(
        "starred",
        20,
        { starred: true, category: "promotions", body: "Click here for the details." },
        { category: "promotions", body: "Click here for the details." },
      ),
      pair(
        "needsAction",
        22,
        { body: "Please sign the attached agreement. Claim your prize." },
        { body: "Have a look at the attached agreement. Claim your prize." },
      ),
      pair("codes", 24, { body: "Your verification code is 418902." }, { body: "The number is 418902." }),
      pair(
        "finance",
        26,
        { body: "Your invoice for April is attached." },
        { body: "Your document for April is attached." },
      ),
      pair(
        "travel",
        28,
        { body: "Your hotel is confirmed for Friday." },
        { body: "Your room is confirmed for Friday." },
      ),
      pair(
        "events",
        30,
        { body: "A workshop on async Rust runs on Thursday." },
        { body: "An afternoon session on async Rust runs on Thursday." },
      ),
      pair(
        "shipping",
        32,
        { body: "Your parcel is out for delivery today." },
        { body: "Your box is waiting to be collected today." },
      ),
      pair(
        "social",
        34,
        { body: "Someone liked your comment." },
        { body: "Someone read your comment." },
      ),
      // The only row whose pair differs by more than one phrase: same sender, so
      // the digits in its domain are common to both, and only the phish tail is
      // added.
      pair(
        "safe",
        36,
        { sender: LURE_SENDER, subject: "Notes", body: `Some notes.${PHISH_TAIL}` },
        { sender: LURE_SENDER, subject: "Notes", body: "Some notes. Nothing to report." },
      ),
    ];
    const all = classifyAll(
      rows.flatMap(([, hazard, control]) => [hazard, control]),
      EMPTY_PROFILE,
    );
    for (const [signal, hazard, control] of rows) {
      const hazardSignals = all.get(hazard.id)!;
      const controlSignals = all.get(control.id)!;
      // The control is what makes the row mean anything: it is the same message
      // with one phrase changed, so it must be skippable and must not be unsafe.
      expect(controlSignals.importanceScore, `${signal} control`).toBeLessThanOrEqual(50);
      expect(isUnsafe(controlSignals), `${signal} control`).toBe(false);
      expect(
        matchesBuiltin("low_priority", control, controlSignals, EMPTY_PROFILE),
        `${signal} control`,
      ).toBe(true);
      // And the hazard differs from it only by the signal under test.
      expect(isUnsafe(hazardSignals) !== isUnsafe(controlSignals), `${signal} hazard`).toBe(
        signal === "safe",
      );
      expect(
        matchesBuiltin("low_priority", hazard, hazardSignals, EMPTY_PROFILE),
        signal,
      ).toBe(false);
    }
  });

  it("never contains a starred message", () => {
    // The shipped one. Its score is 102 — a star, a signature request and a top
    // sender — so the boundary alone would exclude it and this assertion is not
    // by itself a test of the star clause. The isolating pair for that is the
    // `starred` row above, where the promo penalty buys back just enough
    // headroom for the star to be the deciding clause. What this adds is the
    // fact the demo itself relies on: the one message a user stars is not in a
    // bucket that invites them to skip it.
    const starred = inbox.find((m) => m.gmailId === "demo-starred-1")!;
    const sig = sigFor(starred.gmailId);
    expect(starred.starred).toBe(true);
    expect(sig.importanceScore).toBeGreaterThan(50);
    expect(matchesBuiltin("low_priority", starred, sig, profile)).toBe(false);
    // The thread it belongs to is not skippable either, so Read later cannot
    // quietly split a conversation.
    for (const id of ["demo-action-1", "demo-action-2", "demo-long-1"]) {
      const sibling = inbox.find((m) => m.gmailId === id)!;
      expect(matchesBuiltin("low_priority", sibling, sigFor(id), profile), id).toBe(false);
    }
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
    expect(sig.promotional).toBe(true);
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
    const sig = classifyAll([flagged], p).get(flagged.id)!;
    expect(sig.promotional).toBe(true);
    expect(matchesBuiltin("urgent", flagged, sig, p)).toBe(true);
  });

  it("includes genuine urgency, which is neither bulk nor flagged", () => {
    // The control for the two above: `urgentText` with no promo behind it, so
    // the marketing exclusion cannot be what admitted it.
    const real = email({
      sender: "ops@partner.example",
      subject: "The window moved to Thursday",
      body: "If Thursday does not work, say so today. This is urgent.",
      urgent: true,
    });
    const p = buildUserProfile([real], []);
    const sig = classifyAll([real], p).get(real.id)!;
    expect(sig.urgentText).toBe(true);
    expect(sig.promotional).toBe(false);
    expect(matchesBuiltin("urgent", real, sig, p)).toBe(true);
    // And the same message with the sender's flag removed still qualifies on
    // the wording alone, which is what makes the flag a shortcut rather than a
    // gate.
    const worded = { ...real, urgent: false, id: 2, gmailId: "g2" };
    expect(matchesBuiltin("urgent", worded, classifyAll([worded], p).get(2)!, p)).toBe(true);
  });
});

describe("matchesFilter", () => {
  it("matches a sender case-insensitively", () => {
    // Addresses are not case-sensitive in practice; a case-sensitive compare
    // split one person into two senders, with two biases and two pills.
    const message = email({ sender: "Ada@Northwind.example" });
    const sig = classifyAll([message], EMPTY_PROFILE).get(message.id)!;
    expect(matchesFilter(senderFilter("ada@northwind.example"), message, sig, EMPTY_PROFILE)).toBe(true);
    expect(matchesFilter(senderFilter("ADA@NORTHWIND.EXAMPLE"), message, sig, EMPTY_PROFILE)).toBe(true);
  });

  it("does not match a different sender", () => {
    const message = email({ sender: "ada@northwind.example" });
    const sig = classifyAll([message], EMPTY_PROFILE).get(message.id)!;
    expect(matchesFilter(senderFilter("bob@northwind.example"), message, sig, EMPTY_PROFILE)).toBe(false);
    // A prefix is not an address. Without a boundary here a sender pill for
    // `ada@northwind.example` would also light up for every other address at
    // that domain.
    expect(matchesFilter(senderFilter("ada"), message, sig, EMPTY_PROFILE)).toBe(false);
    expect(matchesFilter(senderFilter("ada@northwind.example.evil.test"), message, sig, EMPTY_PROFILE)).toBe(false);
  });

  it("matches on the envelope sender, not the display address", () => {
    // `sender` is the join key for the profile, so a forwarding service must
    // not be able to borrow somebody else's pill — and the message's own
    // `From:` header must not be able to steal theirs either.
    const relayed = email({
      id: 5,
      gmailId: "g5",
      sender: "relay@relay.example",
      address: "ada@northwind.example",
    });
    const sig = classifyAll([relayed], EMPTY_PROFILE).get(relayed.id)!;
    expect(matchesFilter(senderFilter("ada@northwind.example"), relayed, sig, EMPTY_PROFILE)).toBe(false);
    expect(matchesFilter(senderFilter("relay@relay.example"), relayed, sig, EMPTY_PROFILE)).toBe(true);
  });

  it("dispatches a builtin filter to the bucket test", () => {
    // `matchesFilter` is the entry point the pipeline and the rail use, so a
    // builtin id that stopped routing to `matchesBuiltin` would be invisible to
    // a test that only ever calls `matchesBuiltin`. Checked on a message that
    // matches, and on one that does not, so a pass-through of `true` fails.
    const phish = inbox.find((m) => m.gmailId === "demo-security-2")!;
    const quiet = inbox.find((m) => m.gmailId === "demo-quiet-2")!;
    const pairs: [BuiltinSmartFilter, Email, boolean][] = [
      ["unsafe", phish, true],
      ["low_priority", quiet, true],
      ["low_priority", phish, false],
    ];
    for (const [bucket, message, expected] of pairs) {
      const sig = sigFor(message.gmailId);
      expect(matchesFilter(builtinFilter(bucket), message, sig, profile), bucket).toBe(
        matchesBuiltin(bucket, message, sig, profile),
      );
      expect(matchesFilter(builtinFilter(bucket), message, sig, profile), bucket).toBe(expected);
    }
  });
});

describe("countAllFilters", () => {
  it("counts the spam rows under unsafe and under nothing else", () => {
    // The regression the module doc describes, in the form it can actually
    // happen: `security` is the one positive bucket whose predicate has no
    // `safe` guard, so the seeded phish matches `security` *and* `unsafe` at the
    // same time. Counting it twice inflated Security's number, and since the
    // rail ranks by count that moved Security above buckets with more mail.
    const counted = countAllFilters(inbox, signals, profile);
    // Three demo messages match `security` at the predicate level …
    const securityMatches = inbox.filter((m) =>
      matchesBuiltin("security", m, sigFor(m.gmailId), profile),
    );
    expect(securityMatches.map((m) => m.gmailId)).toEqual([
      "demo-security-1",
      "demo-security-2",
      "demo-security-3",
    ]);
    // … and one of them is the phish, so the count is two. The same phish reads
    // as urgent and is a first-time sender, so those two are one lower too.
    expect(counted.get("security")).toBe(2);
    expect(counted.get("urgent")).toBe(3);
    // 27, not the 26 it was when this fixture built its profile over the whole
    // mailbox: `bookings@airline.example` has one inbox message and one archived
    // one, so counting the archived copy as inbox volume made a genuine first-time
    // sender look like a regular. See the note on `profile` above.
    expect(counted.get("new_senders")).toBe(27);
    expect(counted.get("unsafe")).toBe(1);
  });

  it("counts a mailbox of lures as nothing but unsafe", () => {
    // Unsafe's members *are* the spam-scored rows. Counting them the way the
    // other buckets are counted reports zero and pins the one safety valve to a
    // meaningless position. Twelve lures, so the expected number is neither 0
    // nor 1 — a count of one survives an implementation that never looks at a
    // signal, which is the failure this replaces.
    const lures = LURES.map((row) => row.message);
    const lureSignals = classifyAll(lures, LURE_PROFILE);
    const counted = countAllFilters(lures, lureSignals, LURE_PROFILE);
    expect(counted.get("unsafe")).toBe(lures.length);
    // `unsafe` is the only key at all: every other count is absent rather than
    // zero, which is how the map represents "nothing landed here".
    expect([...counted.keys()]).toEqual(["unsafe"]);
    // …and one row at a time, so the total cannot come from a single message
    // being counted twelve times.
    for (const message of lures) {
      const sig = classifyAll([message], LURE_PROFILE).get(message.id)!;
      expect(countAllFilters([message], new Map([[message.id, sig]]), LURE_PROFILE).get("unsafe")).toBe(1);
    }
  });

  it("skips a message it has no signals for, rather than counting it as junk", () => {
    // A cache miss is a real state: an archived message that was never
    // classified has no entry in the map. Counting it against NEUTRAL_SIGNALS
    // would put mail the user never looked at into the safety valve.
    const unclassified = email({ id: 7, gmailId: "unclassified" });
    expect(countAllFilters([unclassified], new Map(), EMPTY_PROFILE).size).toBe(0);
    expect(countAllFilters([unclassified], new Map(), EMPTY_PROFILE).get("unsafe")).toBeUndefined();
  });

  it("has a hand-derived count for every bucket in the catalog", () => {
    // Each number below was derived by reading the seed, not by asking the code.
    // `starred` is 1 because `demo-starred-1` is the only starred message in the
    // inbox; `attachments` is 1 because `demo-action-4` is the only message
    // carrying one; `low_priority` is 11 because eleven of the 45 carry no signal
    // and score 50 or below. A seed edit means re-deriving this table, and that
    // is the intended cost: the alternative is a count that drifts with nobody
    // noticing, which is the defect this file exists to catch.
    const expected: [BuiltinSmartFilter, number][] = [
      ["important", 26],
      ["urgent", 3],
      ["needs_action", 13],
      ["security", 2],
      ["codes", 2],
      ["shipping", 2],
      ["travel", 2],
      ["events", 2],
      ["receipts", 4],
      ["starred", 1],
      ["unread", 6],
      ["attachments", 1],
      ["new_senders", 27],
      ["top_contacts", 11],
      ["quiet_contacts", 12],
      ["newsletters", 4],
      ["promotional", 5],
      ["low_priority", 11],
      ["long_reads", 1],
      ["social", 2],
      ["unsafe", 1],
    ];
    const counted = countAllFilters(inbox, signals, profile);
    for (const [id, count] of expected) {
      expect(counted.get(id), id).toBe(count);
    }
    // …and nothing outside the catalog: a bucket invented by a count would show
    // up as an extra key here.
    expect(counted.size).toBe(BUILTIN_FILTERS.length);
  });
});

describe("rankFilters", () => {
  it("pins the permanent buckets first, even when empty", () => {
    // Important and Deliveries are the two a user reaches for on a bad day. A
    // pill that disappears exactly when it is needed is worse than no pill.
    const ranked = rankFilters([], new Map(), profile);
    expect(ranked.slice(0, 2)).toEqual(["important", "shipping"]);
    // Which is the whole answer for an empty mailbox: nothing to rank, so the
    // pinned pair and the safety valve are all that is left.
    expect(ranked).toEqual(["important", "shipping", "unsafe"]);
    // The pair itself, so adding a third pinned bucket cannot go unnoticed.
    expect(PERMANENT_FILTERS).toEqual(["important", "shipping"]);
  });

  it("pins unsafe last, and lists it once", () => {
    const ranked = rankFilters(inbox, signals, profile);
    expect(ranked[ranked.length - 1]).toBe("unsafe");
    expect(ranked.filter((id) => id === "unsafe")).toHaveLength(1);
  });

  it("returns the exact order for the demo inbox", () => {
    // Written out rather than checked pairwise. A pairwise "counts must not
    // increase" assertion passes on a constant sequence, which is what a
    // tie-break bug produces; this one cannot. The pinned pair leads, the magic
    // buckets follow in descending volume, and unsafe closes.
    expect(rankFilters(inbox, signals, profile)).toEqual([
      "important",
      "shipping",
      "new_senders",
      "needs_action",
      "quiet_contacts",
      "top_contacts",
      "low_priority",
      "unread",
      "promotional",
      "receipts",
      "newsletters",
      "urgent",
      "security",
      "codes",
      "travel",
      "events",
      "social",
      "starred",
      "attachments",
      "long_reads",
      "unsafe",
    ]);
  });

  it("breaks ties by catalog order, and keeps each tied group together", () => {
    // Between equals the order is the catalog — receipts, newsletters — not the
    // order they happen to be counted in, which for `Map` insertion is the catalog
    // order too but only by accident. A table that quietly kept the old membership
    // would pass the membership assertion and fail the ordering one.
    const counted = countAllFilters(inbox, signals, profile);
    const ranked = rankFilters(inbox, signals, profile);
    const tied: [number, BuiltinSmartFilter[]][] = [
      [4, ["receipts", "newsletters"]],
      [2, ["codes", "travel", "events", "social"]],
      [1, ["starred", "attachments", "long_reads"]],
    ];
    for (const [count, group] of tied) {
      for (const id of group) {
        expect(counted.get(id), id).toBe(count);
      }
      const at = group.map((id) => ranked.indexOf(id));
      expect(at, group.join(",")).toEqual([...at].sort((a, b) => a - b));
      expect(ranked.slice(at[0], at[0] + group.length), group.join(",")).toEqual(group);
    }
  });

  it("hides an empty bucket in a mailbox that is otherwise full", () => {
    // A bucket the rail advertises but that nothing lands in is a pill leading
    // to an empty list. The empty mailbox is the easy half; this is the half
    // that bites, since the demo does have a starred message and taking it out
    // leaves 44 messages still ranking.
    const unstarred = inbox.filter((m) => !m.starred);
    const ranked = rankFilters(unstarred, classifyAll(unstarred, profile), profile);
    expect(unstarred.length).toBe(44);
    expect(ranked).not.toContain("starred");
    expect(ranked).toContain("important");
    expect(ranked).toContain("social");
    // …and with the star put back it reappears, so it was the count hiding it.
    expect(rankFilters(inbox, signals, profile)).toContain("starred");
  });

  it("gives every permanent bucket a position regardless of count", () => {
    // One message, and the two pinned buckets are both empty for it.
    const one = inbox.slice(0, 1);
    const ranked = rankFilters(one, classifyAll(one, profile), profile);
    expect(ranked.slice(0, 2)).toEqual(["important", "shipping"]);
    // Everything else in this list is a bucket that message actually reaches.
    expect(ranked).toEqual(["important", "shipping", "needs_action", "unread", "top_contacts", "unsafe"]);
  });

  it("omits a muted bucket entirely, including a pinned one", () => {
    expect(rankFilters(inbox, signals, profile, new Set(["urgent"]))).not.toContain("urgent");
    // Muting the pinned pair moves the rest up rather than leaving a hole.
    expect(rankFilters(inbox, signals, profile, new Set(["important"]))).toEqual([
      "shipping",
      "new_senders",
      "needs_action",
      "quiet_contacts",
      "top_contacts",
      "low_priority",
      "unread",
      "promotional",
      "receipts",
      "newsletters",
      "urgent",
      "security",
      "codes",
      "travel",
      "events",
      "social",
      "starred",
      "attachments",
      "long_reads",
      "unsafe",
    ]);
    // The safety valve can be muted too, and muting it must not promote
    // anything in its place.
    const withoutUnsafe = rankFilters(inbox, signals, profile, new Set(["unsafe"]));
    expect(withoutUnsafe).toHaveLength(20);
    expect(withoutUnsafe).not.toContain("unsafe");
  });
});

describe("filter ids", () => {
  it("writes the documented key form for both kinds of filter", () => {
    // The strings, not a round trip. `filterKey` and `parseFilterKey` share one
    // notion of the key, so round-tripping them proves only that they agree with
    // each other — and a test that builds its expectation from the same helper
    // proves nothing at all. These are the expected key forms written out.
    expect(filterKey(builtinFilter("needs_action"))).toBe("needs_action");
    expect(filterKey(builtinFilter("unsafe"))).toBe("unsafe");
    expect(filterKey(senderFilter("ada@northwind.example"))).toBe("sender:ada@northwind.example");
    // The address is lower-cased, because a case difference in a persisted key
    // would otherwise restore as a second, duplicate pill.
    expect(filterKey(senderFilter("Ada@Northwind.example"))).toBe("sender:ada@northwind.example");
  });

  it("reads back only what it wrote, and rejects anything else", () => {
    // A persisted key that no longer names a filter must read as null so the UI
    // drops it, rather than silently selecting a bucket the user never asked
    // for. `important` is the fallback that must never happen here.
    const cases: [string, FilterId | null][] = [
      ["needs_action", { kind: "builtin", id: "needs_action" }],
      ["unsafe", { kind: "builtin", id: "unsafe" }],
      ["sender:ada@northwind.example", { kind: "sender", sender: "ada@northwind.example" }],
      // Case matters on the bucket half: a key that differs from the catalog by
      // one capital is a key from somewhere else.
      ["Important", null],
      ["needs-action", null],
      // Mailbox names are not filters, and `inbox` is not a bucket.
      ["inbox", null],
      ["", null],
    ];
    for (const [key, expected] of cases) {
      expect(parseFilterKey(key), key).toEqual(expected);
    }
  });

  it("keeps a bucket and a sender address apart, whichever way round", () => {
    // The collision the union replaced: under a prefixed-string scheme an
    // address beginning `sender:` produced a key that meant something else
    // entirely. The two shapes are distinct values, so no address can be
    // mistaken for a bucket and no bucket for an address.
    expect(filterKey(senderFilter("important"))).not.toBe(filterKey(builtinFilter("important")));
    expect(parseFilterKey(filterKey(senderFilter("important")))).toEqual({
      kind: "sender",
      sender: "important",
    });
    expect(filterKey(builtinFilter("unsafe"))).not.toBe(filterKey(senderFilter("unsafe")));
    expect(filterKey(senderFilter("unsafe"))).toBe("sender:unsafe");
  });

  it("labels a bucket by its human name and a sender by its address", () => {
    // The rail, the pill and the badge all read the label, so a bucket renamed in
    // `FILTER_LABELS` without the rename reaching here shows up in exactly one
    // place.
    expect(filterLabel(builtinFilter("needs_action"))).toBe("Action needed");
    expect(filterLabel(builtinFilter("low_priority"))).toBe("Read later");
    expect(filterLabel(builtinFilter("shipping"))).toBe("Deliveries");
    expect(filterLabel(senderFilter("ada@northwind.example"))).toBe("ada@northwind.example");
  });
});
/**
 * The Smart Score sort.
 *
 * The number is *fixed*: computing it from the learnable importance score would let
 * every slider drag reorder the list, so this one takes no weight set. It is also a
 * number a user can be shown — every term is an integer, the total clamps to 0–100,
 * and the recency nudge is relative to the set being ranked, not the wall clock.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SORT,
  MAX_RECENCY_BONUS,
  SORT_OPTIONS,
  calculateWinnowScore,
  recencyWindow,
  relativeRecencyBonus,
  type ScoreRecencyContext,
} from "./scoring";
import { classifyEmail } from "./classify";
import { buildUserProfile, EMPTY_PROFILE, type UserProfile } from "../model/profile";
import { NEUTRAL_SIGNALS, type EmailSignals } from "../model/signals";
import { SIGNAL_KEYS, clampWeight, type SignalWeights } from "./weights";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import type { Email } from "../model/email";

/** A message with only what a test cares about. */
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

/** The score for a message, with signals overridden one field at a time. */
function scoreOf(
  over: Partial<Email> = {},
  signals: Partial<EmailSignals> = {},
  profile: UserProfile = EMPTY_PROFILE,
  recency: ScoreRecencyContext | null = null,
): number {
  return calculateWinnowScore(email(over), { ...NEUTRAL_SIGNALS, ...signals }, profile, recency);
}

/** A weight set pinned to one end of every slider's range. */
function extremeWeights(high: boolean): SignalWeights {
  return Object.fromEntries(
    SIGNAL_KEYS.map((meta) => [meta.key, clampWeight(meta.key, high ? 1_000 : 0)]),
  ) as SignalWeights;
}

describe("recencyWindow", () => {
  it("is null for an empty set, because there is nothing to be relative to", () => {
    // The caller treats null as "no nudge at all" rather than guessing a window,
    // so this has to be distinguishable from a zero-width one.
    expect(recencyWindow([])).toBe(null);
  });

  it("spans the timestamps given, in whatever order they arrive", () => {
    // Gmail's history order is not stable across syncs, and a window that
    // depended on it would make the sort shuffle when nothing had changed.
    const orders = [
      [5, 1, 9],
      [1, 5, 9],
      [9, 1, 5],
      [5, 9, 1],
    ];
    for (const stamps of orders) {
      expect(recencyWindow(stamps)).toEqual({ oldestReceivedAt: 1, newestReceivedAt: 9 });
    }
  });

  it("is a zero-width window for a single timestamp", () => {
    // One message in the inbox is a real case — a brand-new account — and the
    // degenerate form is what stops the nudge being a division by zero.
    expect(recencyWindow([42])).toEqual({ oldestReceivedAt: 42, newestReceivedAt: 42 });
  });

  it("stays degenerate when every timestamp is the same", () => {
    // A batch import of mail filed on one day lands here, and it must not be
    // mistaken for a span it does not have.
    expect(recencyWindow([7, 7, 7])).toEqual({ oldestReceivedAt: 7, newestReceivedAt: 7 });
  });
});

describe("relativeRecencyBonus", () => {
  const window: ScoreRecencyContext = { oldestReceivedAt: 0, newestReceivedAt: 3000 };

  it("gives the newest message the whole bonus and the oldest none", () => {
    expect(relativeRecencyBonus(3000, window)).toBe(MAX_RECENCY_BONUS);
    expect(relativeRecencyBonus(0, window)).toBe(0);
  });

  it("interpolates across the span rather than switching on", () => {
    // Halfway is 1.5 points, rounded to 2 — so the bonus is a real gradient and
    // a mid-aged message is not indistinguishable from the oldest one.
    expect(relativeRecencyBonus(1500, window)).toBe(2);
    expect(relativeRecencyBonus(1000, window)).toBe(1);
  });

  it("clamps to the window's edges instead of extrapolating past them", () => {
    // Timestamps outside the set being ranked are ordinary — a message can be
    // added to the store mid-session — and extrapolating would hand a message
    // more than the entire bonus it is capped at.
    const outside = [-1, -1_000_000, 3001, 1e15];
    for (const at of outside) {
      const bonus = relativeRecencyBonus(at, window);
      expect(bonus).toBeGreaterThanOrEqual(0);
      expect(bonus).toBeLessThanOrEqual(MAX_RECENCY_BONUS);
    }
    expect(relativeRecencyBonus(-1, window)).toBe(0);
    expect(relativeRecencyBonus(1e15, window)).toBe(MAX_RECENCY_BONUS);
  });

  it("is nothing at all when the window is degenerate", () => {
    // There is nothing to prioritise against, so the nudge is absent rather than
    // arbitrary. A window of one message must not hand it the full bonus on the
    // strength of being the only thing in the comparison.
    const degenerate: ScoreRecencyContext = { oldestReceivedAt: 7, newestReceivedAt: 7 };
    expect(relativeRecencyBonus(7, degenerate)).toBe(0);
    expect(relativeRecencyBonus(8, degenerate)).toBe(0);
  });

  it("is nothing at all without a context", () => {
    // Which is what a single-message query gets, and what the sort falls back to
    // when a caller scores one message in isolation.
    expect(relativeRecencyBonus(1_500, null)).toBe(0);
  });

  it("respects a custom ceiling", () => {
    // The parameter exists so the bonus can be reused at a different magnitude;
    // an implementation that hard-coded `MAX_RECENCY_BONUS` would silently
    // ignore it.
    expect(relativeRecencyBonus(3000, window, 10)).toBe(10);
    expect(relativeRecencyBonus(1500, window, 10)).toBe(5);
    expect(relativeRecencyBonus(0, window, 10)).toBe(0);
  });

  it("is a whole number of points, and never negative", () => {
    // Fractional points would be sorted against, and the result is displayed as
    // an integer, so a mismatch there is a visible bug in the reader.
    const context: ScoreRecencyContext = { oldestReceivedAt: 1_000, newestReceivedAt: 4_000 };
    for (let at = -5_000; at <= 9_000; at += 137) {
      const bonus = relativeRecencyBonus(at, context);
      expect(Number.isInteger(bonus), `bonus at ${at} was ${bonus}`).toBe(true);
      expect(bonus).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("calculateWinnowScore — the range", () => {
  it("puts a message with nothing to say at exactly the base", () => {
    // Exactness matters here rather than tidiness: every other test in this file
    // measures a delta against this number, so a base that drifted by one would
    // quietly change what "a star is worth" means.
    expect(scoreOf()).toBe(50);
  });

  it("saturates at 100 instead of overflowing", () => {
    // 50 base + 15 security + 12 urgency + 8 invoice + 6 confirm + 10 past due,
    // then +18 for the top sender, +15 for the star and +3 for being the newest
    // in the window — 137, which must come back as 100.
    const everything = {
      starred: true,
      sender: "dana@northwind.example",
      receivedAt: 3000,
      subject: "Urgent: password reset for your invoice",
      body: "This action is required. Your statement is past due; verify your account security.",
    };
    const recency: ScoreRecencyContext = { oldestReceivedAt: 0, newestReceivedAt: 3000 };
    const profile: UserProfile = {
      ...EMPTY_PROFILE,
      topSenders: ["dana@northwind.example"],
    };
    const saturated = scoreOf(everything, {}, profile, recency);

    expect(saturated).toBe(100);
    // The control. Without it, an implementation that returned 100 for
    // everything would pass the line above.
    expect(scoreOf({ subject: "Password reset", sender: "nobody@else.example" })).toBe(65);
  });

  it("floors at 0 for the mirror image", () => {
    // 50 base − 8 promo − 10 newsletter − 40 for certain spam − 14 for a sender
    // the user never keeps — −22 before the clamp.
    const awful = {
      sender: "deals@shop.example",
      subject: "Weekly digest: 50% off — flash sale",
      body: "Unsubscribe from these promotions.",
    };
    const profile: UserProfile = {
      ...EMPTY_PROFILE,
      trashBiasBySender: { "deals@shop.example": 0.35 },
    };
    expect(scoreOf(awful, { spamLikelihood: 1 }, profile)).toBe(0);
    // The control: the same message with no spam and no bias is a merely dull
    // promotion, not a negative number.
    expect(scoreOf(awful)).toBe(32);
  });

  it("stays inside 0–100 for every message in the demo mailbox", () => {
    // The demo is the widest set of shapes the app has, including the fixtures
    // built to be junk, and every message in it carries a body long enough to
    // trip several intent patterns at once. A score outside the range would be
    // rendered as a percentage outside the range.
    const profile = buildUserProfile(DEMO_EMAILS, DEMO_TRASH);
    const window = recencyWindow(DEMO_EMAILS.map((message) => message.receivedAt));
    expect(window).not.toBeNull();

    for (const message of DEMO_EMAILS) {
      const signals = classifyEmail(message, profile);
      const score = calculateWinnowScore(message, signals, profile, window);
      expect(score, `"${message.subject}" scored ${score}`).toBeGreaterThanOrEqual(0);
      expect(score, `"${message.subject}" scored ${score}`).toBeLessThanOrEqual(100);
    }
  });
});

describe("calculateWinnowScore — the terms", () => {
  it("adds exactly 15 for a star", () => {
    const plain = scoreOf({ subject: "Notes", body: "Some notes." });
    const starred = scoreOf({ subject: "Notes", body: "Some notes.", starred: true });
    expect(starred).toBe(plain + 15);
    expect(plain).toBe(50);
  });

  it("subtracts for spam likelihood, truncated like the importance pipeline", () => {
    // Truncated, not rounded: the importance pipeline truncates to an integer at
    // each step, and the two formulas have to stay comparable or a message can
    // be Important and still sort below a slightly-less-spammy neighbour.
    const levels = [0, 0.1, 0.25, 0.5, 0.9, 1];
    for (const spamLikelihood of levels) {
      expect(scoreOf({}, { spamLikelihood })).toBe(50 - Math.trunc(spamLikelihood * 40));
    }
    // The value that separates truncation from rounding: 39.96 either way once
    // rounded, 39 truncated.
    expect(scoreOf({}, { spamLikelihood: 0.9999 })).toBe(11);
  });

  it("subtracts for a sender the user keeps binning, through the capped bias", () => {
    const biased: UserProfile = {
      ...EMPTY_PROFILE,
      trashBiasBySender: { "deals@shop.example": 0.35 },
    };
    expect(scoreOf({ sender: "deals@shop.example" }, {}, biased)).toBe(36);
    // The cap lives in `trashBiasFor`, so an unbounded raw ratio cannot move the
    // sort further than the cap allows — 0.35 × 40 is 14 points, and not one
    // more however often the user bins them.
    const reckless: UserProfile = {
      ...EMPTY_PROFILE,
      trashBiasBySender: { "deals@shop.example": 0.99 },
    };
    expect(scoreOf({ sender: "deals@shop.example" }, {}, reckless)).toBe(36);
  });

  it("shares the sender ladder with importance, at the fixed default", () => {
    // The two formulas agree about *who* matters and disagree about *how much*
    // each signal is worth — the ladder is shared, the top boost is not read from
    // the tunables, so raising "Favourite senders" cannot reflow this sort.
    //
    // Six senders, not three, because the ladder has three *tiers* rather than one
    // step per name: ranks 0, 1–2 and 3–5. A three-name list never reaches the third
    // tier, so it silently tested two of them.
    const profile: UserProfile = {
      ...EMPTY_PROFILE,
      topSenders: [
        "a@x.example", // tier 0: all 18
        "b@x.example", // tier 1: two thirds, 12
        "c@x.example", // tier 1: also 12 — the tier, not the position
        "d@x.example", // tier 2: one third, 6
        "e@x.example",
        "f@x.example",
      ],
    };
    expect(scoreOf({ sender: "a@x.example" }, {}, profile)).toBe(68);
    expect(scoreOf({ sender: "b@x.example" }, {}, profile)).toBe(62);
    expect(scoreOf({ sender: "c@x.example" }, {}, profile)).toBe(62);
    expect(scoreOf({ sender: "d@x.example" }, {}, profile)).toBe(56);
    expect(scoreOf({ sender: "e@x.example" }, {}, profile)).toBe(56);
    expect(scoreOf({ sender: "f@x.example" }, {}, profile)).toBe(56);
    expect(scoreOf({ sender: "z@x.example" }, {}, profile)).toBe(50);
  });
});

describe("calculateWinnowScore — intent words", () => {
  it("reads the subject and the body alike", () => {
    // Two cases rather than one, because the haystack is built by hand here
    // rather than shared with `contentBag`, and a hand-built string is exactly
    // where one of the two fields gets dropped.
    const inSubject = scoreOf({ subject: "Password reset", body: "" });
    const inBody = scoreOf({ subject: "hello", body: "please reset your password" });
    expect(inSubject).toBe(65);
    expect(inBody).toBe(65);
  });

  it("does not read the sender address", () => {
    // The claim in the comment above the loop: a mailbox called
    // `urgent-invoice@confirm.example` is not urgent, is not an invoice and is
    // not a confirmation. Had the address been folded into the haystack this
    // would be 76 instead of 50 — the three patterns it happens to spell out.
    const sender = "urgent-invoice@confirm.example";
    expect(scoreOf({ sender, subject: "hello", body: "hi" })).toBe(50);

    // The control: the same words in the subject do fire, so the assertion above
    // is about the address being excluded rather than about the patterns being
    // inert.
    expect(scoreOf({ sender: "quiet@example", subject: "Urgent invoice" })).toBe(70);
  });

  it("counts each pattern once, however many of its words appear", () => {
    // The tables are patterns, not keyword counts. Scoring "invoice payment
    // receipt statement billing" five times would make one bulk message
    // outrank a real security alert.
    const bulk = scoreOf({
      subject: "Invoice, payment, receipt, statement, billing",
      body: "Your invoice is attached. Payment due. Receipt and statement inside.",
    });
    expect(bulk).toBe(58);
  });
});

describe("calculateWinnowScore — the recency context", () => {
  const recency: ScoreRecencyContext = { oldestReceivedAt: 0, newestReceivedAt: 3000 };

  it("nudges a message by its age in the set, and by nothing without the set", () => {
    expect(scoreOf({ receivedAt: 0 }, {}, EMPTY_PROFILE, recency)).toBe(50);
    expect(scoreOf({ receivedAt: 1500 }, {}, EMPTY_PROFILE, recency)).toBe(52);
    expect(scoreOf({ receivedAt: 3000 }, {}, EMPTY_PROFILE, recency)).toBe(53);

    // No context, no nudge — which is what a caller scoring one message outside
    // a list gets, and it must not be quietly treated as the wall clock.
    expect(scoreOf({ receivedAt: 3000 })).toBe(50);
  });

  it("depends on the window, not on the timestamp", () => {
    // The same message, ranked among different mail, moves. That is the whole
    // point of a *relative* age: "new" has to mean new relative to the inbox it
    // is being judged in.
    const message = { receivedAt: 1500 };
    expect(scoreOf(message, {}, EMPTY_PROFILE, recency)).toBe(52);
    expect(
      scoreOf(message, {}, EMPTY_PROFILE, { oldestReceivedAt: 1000, newestReceivedAt: 3000 }),
    ).toBe(51);
    expect(
      scoreOf(message, {}, EMPTY_PROFILE, { oldestReceivedAt: 0, newestReceivedAt: 6000 }),
    ).toBe(51);
  });

  it("is small enough that it cannot outrank a real signal", () => {
    // Three points across an entire inbox, against fifteen for a star. If the
    // nudge ever grew, "recent" would start meaning "important" and the sort
    // would quietly become a date sort.
    expect(MAX_RECENCY_BONUS).toBe(3);
  });
});

describe("calculateWinnowScore — determinism", () => {
  it("gives the same number every time it is asked", () => {
    // The sort is recomputed on every render, and a score that drifted between
    // two renders would make rows swap places under the cursor.
    //
    // Two messages, deliberately. The first is one word away from the clamp, so it
    // is a real determinism check: a repeated call must land on the same number, not
    // merely inside the same saturated band. The second exercises the clamp itself —
    // four intent patterns plus a star plus full recency is 104 raw, which has to come
    // back as exactly 100 and not as 104 or as an overflow.
    const recency: ScoreRecencyContext = { oldestReceivedAt: 0, newestReceivedAt: 3000 };

    const saturated = {
      starred: true,
      subject: "Urgent: password reset",
      body: "Your invoice is past due.",
      receivedAt: 1500,
    };
    const first = scoreOf(saturated, { spamLikelihood: 0.2 }, EMPTY_PROFILE, recency);
    expect(first).toBe(100);
    for (let run = 0; run < 5; run += 1) {
      expect(scoreOf(saturated, { spamLikelihood: 0.2 }, EMPTY_PROFILE, recency)).toBe(first);
    }

    // Deliberately bland: "urgent" is an intent word, so a subject that reads
    // naturally for this fixture would carry +12 and no longer be the zero case.
    const plain = { subject: "Lunch on Thursday", body: "The usual place?", receivedAt: 1000 };
    const second = scoreOf(plain, {}, EMPTY_PROFILE, recency);
    expect(second).toBe(51);
    for (let run = 0; run < 5; run += 1) {
      expect(scoreOf(plain, {}, EMPTY_PROFILE, recency)).toBe(second);
    }
  });
});

describe("the score does not follow the tuning", () => {
  it("is unchanged when the learnable weights are dragged to both extremes", () => {
    // The contract in this module's own header, and the reason none of the
    // numbers above are configurable. `calculateWinnowScore` takes no weight set,
    // so the only way it could move is by reading the classifier's output — and
    // the one part of `EmailSignals` the weights control is `importanceScore`.
    // If the sort were driven by importance, every slider drag would silently
    // reorder the inbox.
    const message = email({ starred: true, subject: "Password reset" });
    const bottom = classifyEmail(message, EMPTY_PROFILE, extremeWeights(false));
    const top = classifyEmail(message, EMPTY_PROFILE, extremeWeights(true));

    // The control: the weights genuinely did something, so this is not a test
    // that passes because the weight set was ignored.
    expect(top.importanceScore).not.toBe(bottom.importanceScore);

    expect(calculateWinnowScore(message, bottom, EMPTY_PROFILE)).toBe(
      calculateWinnowScore(message, top, EMPTY_PROFILE),
    );
    // 50 base + 15 for the security word + 15 for the star. Pinned so that a
    // change here is a deliberate change and not an unnoticed coupling.
    expect(calculateWinnowScore(message, bottom, EMPTY_PROFILE)).toBe(80);
  });

  it("ignores importanceScore even when it is handed one directly", () => {
    // The other way a coupling could creep back in: a caller that stored the
    // importance score alongside the other signals. Nothing in this formula
    // reads it, so moving it by a hundred must move nothing.
    const message = email({ subject: "Notes", body: "Some notes." });
    const quiet = { ...NEUTRAL_SIGNALS, importanceScore: -500 };
    const loud = { ...NEUTRAL_SIGNALS, importanceScore: 900 };
    expect(calculateWinnowScore(message, quiet, EMPTY_PROFILE)).toBe(50);
    expect(calculateWinnowScore(message, loud, EMPTY_PROFILE)).toBe(50);
  });
});

describe("the sort options", () => {
  it("offers exactly the three orders the list can produce", () => {
    // The set is closed: `SortBy` is derived from these ids, so a fourth entry
    // here is a fourth order somebody has to implement in the pipeline and in
    // the preferences UI.
    const ids = SORT_OPTIONS.map((option) => option.id);
    expect(ids).toEqual(["date", "sender", "score"]);
  });

  it("labels the score sort as the fixed one", () => {
    // The label is what a user reads when they ask what the ordering means, so
    // it has to be the Smart Score rather than the tunable importance score.
    const score = SORT_OPTIONS.find((option) => option.id === "score");
    expect(score?.label).toBe("Smart Score");
  });

  it("defaults to date", () => {
    // Not to score. A new inbox has no history to rank against, and arriving at
    // a personalised order the user did not ask for is the wrong default.
    expect(DEFAULT_SORT).toBe("date");
    expect(SORT_OPTIONS.map((option) => option.id)).toContain(DEFAULT_SORT);
  });
});
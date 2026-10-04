import { describe, expect, it } from "vitest";
import { classifyEmail, contentBag, inboxSearchBag, senderRankBonus } from "./classify";
import {
  EMPTY_PROFILE,
  MAX_TRASH_BIAS,
  buildUserProfile,
  tierFor,
  trashBiasFor,
} from "../model/profile";
import { UNSAFE_THRESHOLD, isUnsafe } from "../model/signals";
import { STANDARD_WEIGHTS } from "./weights";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import type { Email } from "../model/email";
import type { EmailSignals } from "../model/signals";

/**
 * A message with only what a test cares about.
 *
 * The sender is a real-looking address because `example.com` is itself a spam
 * tell — leaving it here would add 0.18 to every fixture that does not care
 * about spam and quietly make "not raised by" assertions unprovable. The one
 * test that is *about* that tell passes `someone@example.com` explicitly.
 */
function email(over: Partial<Email> = {}): Email {
  return {
    id: 1,
    gmailId: "g1",
    sender: "dana@northwind.example",
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

/** A real-looking address, because `example.com` is itself a spam tell. */
const REAL = "dana@northwind.example";

describe("classifyEmail — security", () => {
  it("fires on a security alert", () => {
    const signals = classifyEmail(
      email({ subject: "Security alert: unusual sign-in attempt", body: "We noticed a login." }),
      EMPTY_PROFILE,
    );
    expect(signals.security).toBe(true);
    // Base 50 plus the security weight and nothing else: the alert carries no
    // urgency wording and no ask, so it should not quietly pick up both.
    expect(signals.urgentText).toBe(false);
    expect(signals.needsAction).toBe(false);
    expect(signals.importanceScore).toBe(50 + STANDARD_WEIGHTS.security);
  });

  it("treats a bare login code as a code, not an alarm", () => {
    // The distinction the Swift implementation made deliberately: "your OTP is
    // 1234" is something to copy, not something to worry about. Classifying it
    // as security put every 2FA message in the Security bucket.
    const signals = classifyEmail(
      email({ subject: "Your verification code", body: "Your verification code is 418902." }),
      EMPTY_PROFILE,
    );
    expect(signals.codes).toBe(true);
    expect(signals.security).toBe(false);
    // Codes pay nothing: the message is meant to be copied and forgotten.
    expect(signals.importanceScore).toBe(50);
  });

  it("does not fire on 'authentication' inside 'authentication code'", () => {
    const signals = classifyEmail(
      email({ subject: "Sign-in", body: "Your authentication code is 5521." }),
      EMPTY_PROFILE,
    );
    expect(signals.security).toBe(false);
    // The control: the code half is what matched. A test asserting only
    // `security === false` would also pass on a table that had lost both halves.
    expect(signals.codes).toBe(true);
  });

  it("does fire on a failed authentication", () => {
    const signals = classifyEmail(
      email({ subject: "Sign-in blocked", body: "Authentication failed on three attempts." }),
      EMPTY_PROFILE,
    );
    expect(signals.security).toBe(true);
    expect(signals.importanceScore).toBe(50 + STANDARD_WEIGHTS.security);
  });

  it("is not triggered by the sender address alone", () => {
    // A mailbox called `security-alerts@` is not a security notice. The address
    // is excluded from the haystack precisely so this holds.
    const signals = classifyEmail(
      email({ sender: "security@bank.example", subject: "Your statement", body: "Nothing to report." }),
      EMPTY_PROFILE,
    );
    expect(signals.security).toBe(false);
    expect(signals.spamLikelihood).toBe(0);
  });
});

describe("classifyEmail — keyword matching is word-bounded", () => {
  // Every row below names a phrase that is genuinely in a table and is a
  // substring of a word people actually write. Under `String.includes` each one
  // fires; with word boundaries on both ends none of them do. The control beside
  // each hazard is the same slot with the phrase spelled out, which is what
  // makes the row mean something: a matcher that matched nothing at all would
  // fail the control.
  //
  // The sender is a real address on purpose. `example.com` is itself a spam
  // tell, and mixing the two hides which of them is under test.
  const hazards: {
    phrase: string;
    signal: keyof EmailSignals;
    hazard: Email;
    control: Email;
  }[] = [
    {
      phrase: "'liked your'",
      signal: "social",
      hazard: email({ sender: REAL, subject: "Note", body: "She disliked your comment." }),
      control: email({ sender: REAL, subject: "Note", body: "She liked your comment." }),
    },
    {
      phrase: "'check in'",
      signal: "travel",
      hazard: email({ sender: REAL, subject: "Note", body: "Please check into the lobby." }),
      control: email({ sender: REAL, subject: "Note", body: "Please check   in at the desk." }),
    },
    {
      phrase: "'rsvp'",
      signal: "events",
      hazard: email({ sender: REAL, subject: "Note", body: "We need your rsvps for catering." }),
      control: email({ sender: REAL, subject: "Note", body: "Please rsvp for the dinner." }),
    },
    {
      phrase: "'invoice'",
      signal: "finance",
      hazard: email({ sender: REAL, subject: "Note", body: "Invoices are attached." }),
      control: email({ sender: REAL, subject: "Note", body: "Your invoice is attached." }),
    },
    {
      phrase: "'critical'",
      signal: "urgentText",
      hazard: email({ sender: REAL, subject: "Note", body: "This is critically important." }),
      control: email({ sender: REAL, subject: "Note", body: "This is critical." }),
    },
  ];

  it("does not read a phrase out of the middle of a longer word", () => {
    for (const row of hazards) {
      const signals = classifyEmail(row.hazard, EMPTY_PROFILE);
      expect(signals[row.signal], `${row.phrase} fired inside a longer word`).toBe(false);
    }
  });

  it("still reads the phrase when it is written out", () => {
    // The other half of every hazard row. Without it the table above would also
    // be satisfied by a table that had been emptied.
    //
    // "check   in" is three spaces on purpose: the matcher allows flexible
    // whitespace inside a phrase, because the alternative is a line wrap
    // silently costing a message its bucket.
    for (const row of hazards) {
      const signals = classifyEmail(row.control, EMPTY_PROFILE);
      expect(signals[row.signal], row.phrase).toBe(true);
    }
  });

  it("does not read 'act now' out of 'react now'", () => {
    // The one that matters most, because the stack it feeds is what carries the
    // worst junk over the unsafe threshold. "Please react now" is an ordinary
    // note about a poll.
    const hazard = classifyEmail(
      email({ sender: REAL, subject: "Poll", body: "Please react now so we can close the poll." }),
      EMPTY_PROFILE,
    );
    expect(hazard.spamLikelihood).toBe(0);
    const control = classifyEmail(
      email({ sender: REAL, subject: "Poll", body: "Please act now so we can close the poll." }),
      EMPTY_PROFILE,
    );
    expect(control.spamLikelihood).toBeCloseTo(0.15, 10);
  });

  it("does not read a bare 'free' as marketing", () => {
    // `promoRegex` carries `\bfree shipping\b` and `\bfree delivery\b`, not
    // "free". A substring search would call "Freedom of information request" a
    // promo, which is how a bucket the user cannot trust gets muted.
    const freedom = classifyEmail(
      email({ sender: REAL, subject: "Freedom of information request", body: "Your request is under consideration." }),
      EMPTY_PROFILE,
    );
    expect(freedom.promotional).toBe(false);
    const real = classifyEmail(
      email({ sender: REAL, subject: "Free shipping on everything", body: "Free shipping on orders over 50." }),
      EMPTY_PROFILE,
    );
    expect(real.promotional).toBe(true);
    // …and the phrase itself is not a scam tell, so a newsletter carrying it is
    // not dragged towards unsafe by ordinary marketing copy.
    expect(real.spamLikelihood).toBe(0);
  });

  it("does not read a bare 'due' as a bill", () => {
    // The past-due tells are "past due", "overdue", "late fee", "amount due" —
    // all phrases. A bare "due" would match "reduce", "introduce" and "produce",
    // which is most of the English language.
    const reducing = classifyEmail(
      email({ sender: REAL, subject: "Introducing our new service", body: "We produce reports weekly." }),
      EMPTY_PROFILE,
    );
    expect(reducing.finance).toBe(false);
    const real = classifyEmail(
      email({ sender: REAL, subject: "Invoice 2026-0412", body: "Amount due: £60.40 within 14 days." }),
      EMPTY_PROFILE,
    );
    expect(real.finance).toBe(true);
    // The amount is what the regex half of the finance test is for: a bill that
    // says neither "invoice" nor "amount due" still has to be caught.
    const worded = classifyEmail(
      email({ sender: REAL, subject: "Your May wireless bill", body: "Total due: £31.00." }),
      EMPTY_PROFILE,
    );
    expect(worded.finance).toBe(true);
  });
});

describe("classifyEmail — buckets do not overlap", () => {
  it("a promo is not a receipt", () => {
    const signals = classifyEmail(
      email({
        subject: "20% off your next order",
        body: "Use code SAVE20 at checkout for 20% off your next order.",
        category: "promotions",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.promotional).toBe(true);
    expect(signals.finance).toBe(false);
  });

  it("a security notice is not a receipt", () => {
    const signals = classifyEmail(
      email({
        subject: "Security alert",
        body: "A payment of £50 was attempted from a new device. Verify your account.",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.security).toBe(true);
    expect(signals.finance).toBe(false);
  });

  it("a newsletter is not travel", () => {
    const signals = classifyEmail(
      email({
        subject: "This week in aviation",
        body: "Unsubscribe any time. View in browser. This week: a flight review and a hotel guide.",
        category: "newsletter",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.newsletter).toBe(true);
    expect(signals.travel).toBe(false);
  });

  it("a receipt that quotes a promo is a promo, not a receipt", () => {
    // The gate is on the *computed* promotional, not on Gmail's category: a
    // retailer files its receipt wherever it likes, and "your order" is in the
    // finance table on purpose.
    const signals = classifyEmail(
      email({
        subject: "Your order is confirmed — 20% off",
        body: "20% off your next order. Use code SAVE20.",
        category: "receipts",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.promotional).toBe(true);
    expect(signals.finance).toBe(false);
  });
});

describe("classifyEmail — bulk mail", () => {
  it("needs two unsubscribe-style tells, or Gmail's own label", () => {
    const one = classifyEmail(
      email({ sender: REAL, subject: "Our newsletter", body: "We thought you would like this." }),
      EMPTY_PROFILE,
    );
    expect(one.newsletter).toBe(false);

    const two = classifyEmail(
      email({ sender: REAL, subject: "Our newsletter", body: "Unsubscribe any time. View in browser." }),
      EMPTY_PROFILE,
    );
    expect(two.newsletter).toBe(true);
    // Two distinct phrases, and the penalty is exactly the weight — no second
    // deduction for being an issue twice in a month.
    expect(two.importanceScore).toBe(50 - STANDARD_WEIGHTS.newsletterPenalty);
  });

  it("trusts Gmail's category outright", () => {
    const signals = classifyEmail(
      email({ sender: REAL, subject: "Issue 412", body: "Short.", category: "newsletter" }),
      EMPTY_PROFILE,
    );
    expect(signals.newsletter).toBe(true);
    // The body carries no unsubscribe wording at all, which is what makes this
    // the control for the test above rather than a second copy of it.
    expect(signals.spamLikelihood).toBe(0);
    expect(signals.importanceScore).toBe(50 - STANDARD_WEIGHTS.newsletterPenalty);
  });
});

describe("classifyEmail — needsAction", () => {
  it("fires on an explicit ask", () => {
    const signals = classifyEmail(
      email({ sender: REAL, subject: "Re: the plan", body: "Could you send the two slow queries again?" }),
      EMPTY_PROFILE,
    );
    expect(signals.needsAction).toBe(true);
    expect(signals.importanceScore).toBe(50 + STANDARD_WEIGHTS.actionNeeded);
  });

  it("does not fire on 'verify your email', which is a link not a request", () => {
    // Bare "verify" was in the pattern list and matched every verification
    // mail, which put the entire account-recovery flow into "Action needed".
    const signals = classifyEmail(
      email({ sender: REAL, subject: "Verify your email", body: "Click to verify your email address." }),
      EMPTY_PROFILE,
    );
    expect(signals.needsAction).toBe(false);
    // The link is not a tell either: "click to verify" is not "click here", and
    // the message carries no phishing phrasing. Zero, so the assertion above is
    // about the absence of an ask rather than about a score being modest.
    expect(signals.spamLikelihood).toBe(0);
  });

  it("does not fire on a newsletter asking for feedback", () => {
    const signals = classifyEmail(
      email({
        sender: REAL,
        subject: "The Weekly",
        body: "Let me know what you think. Unsubscribe · View in browser.",
        category: "newsletter",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.needsAction).toBe(false);
  });

  it("does not fire on a promo asking the reader to confirm their address", () => {
    // The other half of the bulk gate: every promo ends with a confirmation
    // request, and counting those would bury a colleague's real ask.
    const signals = classifyEmail(
      email({
        sender: REAL,
        subject: "Confirm your email for 20% off",
        body: "Please confirm your email address to unlock the discount. 20% off everything today only.",
        category: "promotions",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.promotional).toBe(true);
    expect(signals.needsAction).toBe(false);
  });
});

describe("classifyEmail — spam likelihood", () => {
  it("is very high for an empty subject and body", () => {
    // Both empty is 0.55, not 0.75: the two tells are alternatives, not
    // independent, so a message carrying one is not scored as though it carried
    // both.
    const signals = classifyEmail(email({ sender: REAL, subject: "", body: "" }), EMPTY_PROFILE);
    expect(signals.spamLikelihood).toBeCloseTo(0.55, 10);
    expect(isUnsafe(signals)).toBe(true);
  });

  it("is much lower for an empty subject alone", () => {
    // A one-line note from a real person is ordinary mail that happens to lack a
    // subject. At 0.2 it is nowhere near unsafe, which is the whole reason the
    // two weights differ.
    const signals = classifyEmail(
      email({ sender: REAL, subject: "", body: "Just one line." }),
      EMPTY_PROFILE,
    );
    expect(signals.spamLikelihood).toBeCloseTo(0.2, 10);
    expect(isUnsafe(signals)).toBe(false);
  });

  it("is raised by phishing phrasing", () => {
    const signals = classifyEmail(
      email({
        sender: "service@verify.example",
        subject: "Your account will be suspended",
        body: "Your account has been compromised. Click here to verify your password.",
      }),
      EMPTY_PROFILE,
    );
    // Substantial, but not conclusive on its own: the same phrasing appears in
    // real bank security notices, which is why `phishingRegex` excludes
    // "unusual sign-in" that banks send about genuine fraud. One tell plus
    // corroboration is the design.
    expect(signals.spamLikelihood).toBeCloseTo(0.3, 10);
    expect(isUnsafe(signals)).toBe(false);
    // The domain carries no digits, so nothing corroborates it — and the score
    // lands on 37, below the Important threshold, which is why the corroborating
    // tell in the next test exists.
    const drag = Math.trunc(0.3 * STANDARD_WEIGHTS.spamSensitivity);
    expect(signals.importanceScore).toBe(50 - drag);
  });

  it("crosses the threshold when phishing phrasing is corroborated", () => {
    // The digits in the domain are the second tell, worth exactly 0.1, which
    // puts this on 0.4 — the threshold itself. Together they are the difference
    // between a real alert from a real bank and a lookalike.
    const signals = classifyEmail(
      email({
        sender: "no-reply@github-security227.com",
        subject: "Your account will be suspended",
        body: "Your account has been compromised. Click here to verify your password.",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.spamLikelihood).toBeCloseTo(UNSAFE_THRESHOLD, 10);
    // Exactly on the line, so this is the assertion that makes `>=` load-bearing
    // rather than incidental: a `>` here files a phishing lure as ordinary mail.
    expect(isUnsafe(signals)).toBe(true);
  });

  it("is raised by a coercive threat even when the phishing phrases already matched", () => {
    // The regression this exists for. `phishingRegex` is a *binary* test worth a
    // flat 0.3, so adding the coercion phrases to it changed nothing for a
    // message that already said "verify your password" — which is to say, for
    // precisely the worst kind of message. This one scored 0.30, below the
    // threshold, while a subtler campaign scored exactly 0.40.
    //
    // The threat is the part that separates a campaign from a clumsy real notice,
    // so it is scored additively rather than folded into the binary test:
    // 0.3 for the credential demand plus 0.45 for the coercion.
    const signals = classifyEmail(
      email({
        sender: "service@account-verify.example",
        subject: "Your account will be suspended",
        body: "Your account will be suspended unless you verify your password immediately.\n\nFailure to comply within 24 hours will result in permanent closure of your account and all associated data will be removed.",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.spamLikelihood).toBeCloseTo(0.75, 10);
    expect(isUnsafe(signals)).toBe(true);
  });

  it("is not raised by a genuine notice about a delinquent account", () => {
    // The other half of that fix, and the reason the coercion patterns require a
    // *demand* alongside the threat. A bank warning that an unpaid account will
    // be closed is real, common, and must not be filed as phishing — otherwise
    // the Unsafe bucket cries wolf, which is the only way to make it useless.
    //
    // Zero, not merely under the threshold: there is no tell here at all.
    const signals = classifyEmail(
      email({
        sender: "billing@bank.example",
        subject: "Your account will be closed if the balance remains unpaid",
        body: "Your account may be suspended if the minimum balance is not maintained. Please pay the outstanding amount within 7 days to avoid closure.",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.spamLikelihood).toBe(0);
  });

  it("is not raised by an earnest urgent letter about an expiring document", () => {
    // Counted as a case because the coercion weight is additive: two worrying
    // phrasings in one real letter must not add up to unsafe on volume of worry.
    // "Failure to comply … registration being cancelled" is a registrar, not a
    // campaign, which is why the coercion pattern spells out the consequence.
    const signals = classifyEmail(
      email({
        sender: "registry@company.example",
        subject: "Action required: your visa document expires soon",
        body: "Please confirm your details within 14 days. Failure to comply will result in your registration being cancelled. We would rather help you avoid this.",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.spamLikelihood).toBe(0);
    // The letter is genuinely urgent and genuinely asks something, so it scores
    // as one rather than being flattened into nothing.
    expect(signals.urgentText).toBe(true);
    expect(signals.needsAction).toBe(true);
  });

  it("recognises the commonest account-security notice of all", () => {
    // The table had "unrecognized device" — which almost nobody writes, because
    // a service calling your own phone unrecognised reads as a bug to the person
    // receiving it — and missed the form every major service actually uses.
    //
    // The body deliberately carries nothing but the same phrase: an earlier
    // version mentioned "review your sign-in history", which is the other entry
    // in the table, so deleting the new-device phrase left the test green.
    const signals = classifyEmail(
      email({
        sender: "noreply@dropbox.com",
        subject: "We noticed a new device signed in to your account",
        body: "A new device signed in to your account.",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.security).toBe(true);
    expect(signals.importanceScore).toBe(50 + STANDARD_WEIGHTS.security);
  });

  it("still calls a welcome-back mail a welcome-back mail", () => {
    // The guard on that addition. It takes the sign-in *and* the account, so a
    // routine "you signed in successfully" notice — or a newsletter about
    // sign-in features — must not become a security alert.
    const welcome = classifyEmail(
      email({
        sender: "hello@service.example",
        subject: "You signed in successfully",
        body: "You signed in to your account from a new device. Everything looks normal.",
      }),
      EMPTY_PROFILE,
    );
    expect(welcome.security).toBe(false);
    expect(welcome.spamLikelihood).toBe(0);
    // …and it scores nothing at all: base, minus nothing, plus nothing.
    expect(welcome.importanceScore).toBe(50);
  });

  it("is not raised by a click-here link with no credential language", () => {
    // Every newsletter has one of these. Treating it as phishing taught users to
    // ignore the Unsafe bucket, which is the one that must never cry wolf.
    // 0.05 for the `digest@` local part plus 0.08 for the bare call to action.
    const signals = classifyEmail(
      email({
        sender: "digest@news.example",
        subject: "This week in engineering",
        body: "Read more. Click here for the full article. Unsubscribe below.",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.spamLikelihood).toBeCloseTo(0.13, 10);
    expect(isUnsafe(signals)).toBe(false);
  });

  it("is raised by a shouty subject with repeated exclamation marks", () => {
    // 0.12 and nothing else: the body is chosen to carry no scam phrase, so the
    // score is the shoutiness and not a coincidence of two tells.
    const signals = classifyEmail(
      email({ sender: REAL, subject: "DEAL!!! ENDS NOW", body: "Nothing else to say." }),
      EMPTY_PROFILE,
    );
    expect(signals.spamLikelihood).toBeCloseTo(0.12, 10);
  });

  it("is not raised by a caps subject with only one exclamation mark", () => {
    const signals = classifyEmail(
      email({
        sender: REAL,
        subject: "URGENT: THE MIGRATION WINDOW MOVED",
        body: "It is now Thursday.",
      }),
      EMPTY_PROFILE,
    );
    // The `!!` requirement is what separates a real alert from a marketer.
    // Without it, every caps subject from a colleague became spam. (The sender
    // is a real-looking address because `example.com` is itself a spam tell —
    // mixing the two would have hidden which one was under test.)
    expect(signals.spamLikelihood).toBe(0);
    // The wording still reads as urgent, so this is a spam score of zero rather
    // than a message the classifier has stopped understanding.
    expect(signals.urgentText).toBe(true);
  });

  it("is raised by a reserved example.com sender, which is a fixture tell", () => {
    const signals = classifyEmail(
      email({ sender: "someone@example.com", subject: "Hello", body: "Hi there." }),
      EMPTY_PROFILE,
    );
    // `example.com` is the documentation domain. Real mail from it is a seed
    // or a test, and the classifier is allowed to know that.
    expect(signals.spamLikelihood).toBeCloseTo(0.18, 10);
  });

  it("stacks per distinct scam phrase, to a ceiling", () => {
    // 0.15 for the first, +0.08 for each further one, capped at 0.35. Capped
    // because a long, earnest, real message can mention half the table in
    // passing, and the stack must not be a way to reach unsafe on volume.
    const ladder: [string, number][] = [
      ["Nothing to report.", 0],
      ["Claim your prize.", 0.15],
      ["Claim your prize. Free money.", 0.23],
      ["Claim your prize. Free money. Act now.", 0.31],
      ["Claim your prize. Free money. Act now. Buy now. Call now.", 0.35],
      [
        "Claim your prize. Free money. Act now. Buy now. Call now." +
          " Free gift. Earn money. Work from home.",
        0.35,
      ],
    ];
    for (const [body, expected] of ladder) {
      const signals = classifyEmail(email({ sender: REAL, subject: "Offer", body }), EMPTY_PROFILE);
      expect(signals.spamLikelihood, body.slice(0, 40)).toBeCloseTo(expected, 10);
      expect(signals.spamLikelihood, body.slice(0, 40)).toBeLessThanOrEqual(1);
    }
    // The ceiling itself: a message stuffed with every phrase is not 12 tells'
    // worth of spam, it is 0.35 worth.
    const every = classifyEmail(
      email({
        sender: REAL,
        subject: "Offer",
        body: "claim your prize you have won free money act now exclusive deal buy now call now free gift earn money work from home cash bonus increase your",
      }),
      EMPTY_PROFILE,
    );
    expect(every.spamLikelihood).toBeCloseTo(0.35, 10);
  });

  it("weighs importance down after spam, which is the order the two are computed in", () => {
    // Spam is computed *before* importance because importance has to pay for it,
    // and that ordering is the whole design. If the two were folded in the other
    // order these four messages would score identically, since nothing else
    // about them differs.
    //
    // 50, less trunc(0.08 x 44), less trunc(0.15 x 44), less trunc(0.3 x 44),
    // and the last one gains the urgency weight for "immediately" and then loses
    // trunc(0.75 x 44).
    const ladder: [string, number, number][] = [
      ["Just a note about the plan.", 0, 50],
      ["Click here for the notes.", 0.08, 47],
      ["Claim your prize today.", 0.15, 44],
      ["Your account has been compromised.", 0.3, 37],
      [
        "Your account has been compromised. Verify your password immediately" +
          " or your data will be removed.",
        0.75,
        35,
      ],
    ];
    let previous = Number.POSITIVE_INFINITY;
    for (const [body, spam, importance] of ladder) {
      const signals = classifyEmail(email({ sender: REAL, subject: "Notes", body }), EMPTY_PROFILE);
      expect(signals.spamLikelihood, body.slice(0, 40)).toBeCloseTo(spam, 10);
      expect(signals.importanceScore, body.slice(0, 40)).toBe(importance);
      // Strictly falling: a tie would mean the score had stopped tracking spam.
      expect(signals.importanceScore, body.slice(0, 40)).toBeLessThan(previous);
      previous = signals.importanceScore;
    }
  });

  it("is raised by repeated discards of the same sender", () => {
    // 12 discards out of 13 arrivals is a ratio of 0.857, capped to 0.35 and
    // weighted by 0.22 — so exactly 0.077. The cap is why the number is small
    // and constant no matter how long the run of discards gets.
    const profile = buildUserProfile(
      [email({ sender: "deals@shop.example" })],
      Array.from({ length: 12 }, () => ({ sender: "deals@shop.example" })),
    );
    expect(trashBiasFor(profile, "deals@shop.example")).toBe(MAX_TRASH_BIAS);
    const biased = classifyEmail(
      email({ sender: "deals@shop.example", subject: "Hello", body: "Just saying hello." }),
      profile,
    );
    const neutral = classifyEmail(
      email({ sender: REAL, subject: "Hello", body: "Just saying hello." }),
      profile,
    );
    expect(biased.spamLikelihood).toBeCloseTo(0.077, 10);
    expect(neutral.spamLikelihood).toBe(0);
    // …and it costs importance twice over: once through the spam score and once
    // through the bias itself, which is truncated at 14 points per unit rather
    // than scaled by the same sensitivity as the score.
    //
    // The binned sender is also the profile's top sender (it is the only one in
    // the inbox) and a quiet one, which is why the net movement is small in
    // spite of 12 discards — and worth pinning, because a cap on the bias is
    // only worth having if the other two adjustments still show through.
    expect(neutral.importanceScore).toBe(50);
    expect(biased.importanceScore).toBe(
      50 +
        STANDARD_WEIGHTS.topSenderBoost -
        STANDARD_WEIGHTS.quietContactPenalty -
        Math.trunc(0.077 * STANDARD_WEIGHTS.spamSensitivity) -
        Math.trunc(0.35 * 14),
    );
  });

  it("caps trash bias so one sender cannot dominate", () => {
    const profile = buildUserProfile(
      [email({ sender: "deals@shop.example" })],
      Array.from({ length: 500 }, () => ({ sender: "deals@shop.example" })),
    );
    // The raw ratio is 500/502 = 0.996; without the cap this would be 0.996,
    // which is more than half of every score the classifier produces — and which
    // `toBeLessThanOrEqual(0.35)` would catch, while a cap quietly raised to 0.9
    // would not.
    expect(profile.trashBiasBySender["deals@shop.example"]).toBeGreaterThan(0.9);
    expect(trashBiasFor(profile, "deals@shop.example")).toBe(0.35);
    expect(MAX_TRASH_BIAS).toBe(0.35);
    // The cap is the same for a short run and a long one, which is the property
    // that makes it a cap rather than a coincidence.
    const short = buildUserProfile(
      [email({ sender: "deals@shop.example" })],
      Array.from({ length: 3 }, () => ({ sender: "deals@shop.example" })),
    );
    expect(trashBiasFor(short, "deals@shop.example")).toBe(0.35);
    // A sender who was never binned pays nothing, so the cap cannot be reached
    // by accident.
    expect(trashBiasFor(profile, REAL)).toBe(0);
  });
});

describe("classifyEmail — importance", () => {
  it("puts a starred message above an identical unstarred one", () => {
    const starred = classifyEmail(
      email({ sender: REAL, starred: true, subject: "Notes", body: "Some notes." }),
      EMPTY_PROFILE,
    );
    const plain = classifyEmail(email({ sender: REAL, subject: "Notes", body: "Some notes." }), EMPTY_PROFILE);
    expect(starred.importanceScore).toBe(plain.importanceScore + STANDARD_WEIGHTS.starBoost);
    // Exactly: base 50 plus the star weight, for a message carrying no other
    // signal at all. A test comparing two scores to each other passes even if
    // both are wrong in the same way.
    expect(starred.importanceScore).toBe(50 + STANDARD_WEIGHTS.starBoost);
    expect(plain.importanceScore).toBe(50);
  });

  it("penalises a newsletter", () => {
    const newsletter = classifyEmail(
      email({ sender: REAL, subject: "The Weekly", body: "Unsubscribe. View in browser.", category: "newsletter" }),
      EMPTY_PROFILE,
    );
    const plain = classifyEmail(email({ sender: REAL, subject: "Hello", body: "Hi." }), EMPTY_PROFILE);
    expect(newsletter.importanceScore).toBeLessThan(plain.importanceScore);
    // The penalty is the weight and nothing else — a newsletter is not also
    // dragged down by its own spam score, which is 0 here.
    expect(newsletter.importanceScore).toBe(50 - STANDARD_WEIGHTS.newsletterPenalty);
    expect(plain.importanceScore).toBe(50);
  });

  it("pays for a signature request, which is the pattern 'sign' alone missed", () => {
    const signals = classifyEmail(
      email({ sender: REAL, subject: "Contract", body: "Please sign the attached agreement at your convenience." }),
      EMPTY_PROFILE,
    );
    expect(signals.needsAction).toBe(true);
  });

  it("does not fire 'sign in' as a signature request", () => {
    const signals = classifyEmail(
      email({ sender: REAL, subject: "Sign in to your account", body: "Sign in here to continue." }),
      EMPTY_PROFILE,
    );
    expect(signals.needsAction).toBe(false);
    // …and it is not mistaken for a code either: the table has "sign-in code"
    // and "login code", not "sign in here". So this is a message the classifier
    // reads as carrying no signal at all, which is the honest verdict.
    expect(signals.codes).toBe(false);
    expect(signals.importanceScore).toBe(50);
  });
});

describe("classifyEmail — social domains", () => {
  it("recognises a platform address", () => {
    const signals = classifyEmail(
      email({ sender: "notifications@linkedin.com", subject: "You were mentioned", body: "x" }),
      EMPTY_PROFILE,
    );
    expect(signals.social).toBe(true);
  });

  it("checks the display address too, since platforms relay", () => {
    // A message forwarded by a platform carries the platform's domain only on
    // the `From:` header, not on the envelope sender. Checking one and not the
    // other missed every forwarded mention.
    const signals = classifyEmail(
      email({
        sender: "bounces@relay.example",
        address: "notifications@instagram.com",
        subject: "You were mentioned",
        body: "x",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.social).toBe(true);
  });

  it("does not fire on a platform named in the text", () => {
    // The domain is the signal, and the domain is the *sender*. A colleague
    // writing about LinkedIn is a colleague.
    const signals = classifyEmail(
      email({ sender: REAL, subject: "Notes", body: "I applied through linkedin.com yesterday." }),
      EMPTY_PROFILE,
    );
    expect(signals.social).toBe(false);
  });

  it("matches the host, not a substring of it", () => {
    // This is the security-relevant half. The old test was `line.includes(domain)`,
    // so `notlinkedin.com` and `linkedin.com.evil.example` both read as LinkedIn —
    // and a phisher controls everything to the right of the registrable name. A
    // signal that can be claimed by writing a platform's name into your own
    // hostname is worse than no signal, because it files the phish as a routine
    // notification.
    const forgeries = [
      "notifications@notlinkedin.com",
      "support@linkedin.com.evil.example",
      "hi@fake-x.com",
      "list@mylinkedin.com",
      // A subdomain the platform does not control, but the registrable name is.
      "host@unrelated.co",
    ];

    for (const sender of forgeries) {
      expect(classifyEmail(email({ sender }), EMPTY_PROFILE).social, sender).toBe(false);
    }
  });

  it("still admits a subdomain and a display-name form", () => {
    // Host-suffix matching has to keep the legitimate shapes working, or the fix
    // above is just "make the signal stop working". Each of these is a real form:
    // a platform's own subdomain, a bare domain, a trailing dot, and the RFC 5322
    // display-name form several of them actually send.
    const genuine = [
      "notifications@linkedin.com",
      "no-reply@mail.linkedin.com",
      "noreply@twitter.com",
      "me@x.com",
      "linkedin.com",
      "me@twitter.com.",
      "LinkedIn <notifications@linkedin.com>",
    ];

    for (const sender of genuine) {
      expect(classifyEmail(email({ sender }), EMPTY_PROFILE).social, sender).toBe(true);
    }
  });
});

describe("word bags", () => {
  it("the search bag includes the sender", () => {
    const hay = inboxSearchBag(email({ sender: "ada@example.com", subject: "Hi" }));
    expect(hay).toContain("ada@example.com");
  });

  it("the classification bag does not", () => {
    const hay = contentBag(email({ sender: "ada@example.com", subject: "Hi" }));
    expect(hay).not.toContain("ada@example.com");
  });

  it("both bags are the whole message, lowercased, in a fixed order", () => {
    // The exact strings rather than a `toContain`. The classification bag is
    // subject-then-body and neither bag folds case — two properties a
    // `toContain` check cannot see, and both of which change every keyword
    // match in the file if they break.
    const message = email({ sender: "ada@example.com", subject: "MiXeD", body: "Body Text" });
    expect(contentBag(message)).toBe("mixed body text");
    expect(inboxSearchBag(message)).toBe("ada@example.com mixed body text");
    // …and an empty message still produces a bag rather than throwing.
    expect(contentBag(email())).toBe(" ");
  });
});

describe("senderRankBonus", () => {
  const profile = {
    trashBiasBySender: {},
    topSenders: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com", "g@x.com"],
    quietSenders: [],
    firstTimeSenders: [],
  };

  it("gives the top sender the full boost", () => {
    expect(senderRankBonus(profile, "a@x.com", 18)).toBe(18);
    // The boost defaults to the shipped value, so a caller that forgets to pass
    // one does not silently score nobody.
    expect(senderRankBonus(profile, "a@x.com")).toBe(18);
  });

  it("scales down by tier", () => {
    // Two thirds for ranks 1 and 2, one third for ranks 3 to 5, nothing past
    // that. Every rank in each band is checked, because a band that ended one
    // rank early would pass a test that sampled only its first member.
    for (const [sender, expected] of [
      ["b@x.com", 12],
      ["c@x.com", 12],
      ["d@x.com", 6],
      ["e@x.com", 6],
      ["f@x.com", 6],
      ["g@x.com", 0],
      ["z@x.com", 0],
    ] as [string, number][]) {
      expect(senderRankBonus(profile, sender, 18), sender).toBe(expected);
    }
  });

  it("scales the tiers from whatever boost it is given", () => {
    // An odd boost floors rather than rounds: 19 * 2/3 is 12.67, and 19/3 is
    // 6.33. The Swift pipeline truncated at each step and these thresholds were
    // tuned against it.
    expect(senderRankBonus(profile, "a@x.com", 19)).toBe(19);
    expect(senderRankBonus(profile, "b@x.com", 19)).toBe(12);
    expect(senderRankBonus(profile, "d@x.com", 19)).toBe(6);
    // …and a zero boost gives nothing to anyone, rather than falling through to
    // a default.
    expect(senderRankBonus(profile, "a@x.com", 0)).toBe(0);
  });

  it("agrees with the tier function", () => {
    // The two ladders have to stay in step: `senderRankBonus` pays the points
    // and `tierFor` is what the profile and the UI read, and they used to
    // disagree.
    expect(tierFor(profile, "a@x.com")).toBe(0);
    expect(tierFor(profile, "b@x.com")).toBe(1);
    expect(tierFor(profile, "c@x.com")).toBe(1);
    expect(tierFor(profile, "d@x.com")).toBe(2);
    expect(tierFor(profile, "f@x.com")).toBe(2);
    expect(tierFor(profile, "g@x.com")).toBe(3);
    expect(tierFor(profile, "z@x.com")).toBe(3);
  });
});

describe("the demo mailbox", () => {
  const profile = buildUserProfile(DEMO_EMAILS, DEMO_TRASH);

  it("classifies every message without throwing, and produces finite scores", () => {
    for (const message of DEMO_EMAILS) {
      expect(() => classifyEmail(message, profile)).not.toThrow();
    }
    // Not throwing is the weaker half. A `NaN` importance silently empties
    // every score-based bucket while every assertion above still passes, which
    // is what happened when an options object was passed where a weight set was
    // expected.
    for (const message of DEMO_EMAILS) {
      const signals = classifyEmail(message, profile);
      expect(Number.isFinite(signals.importanceScore), message.gmailId).toBe(true);
      expect(Number.isFinite(signals.spamLikelihood), message.gmailId).toBe(true);
      expect(signals.spamLikelihood, message.gmailId).toBeGreaterThanOrEqual(0);
      expect(signals.spamLikelihood, message.gmailId).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic, so a cached classification survives a restart", () => {
    // The cache is keyed on the message and the profile, and the reason that is
    // safe is that nothing in here reads the clock or the filesystem.
    //
    // Compared as a string rather than by deep equality: `toEqual` on 52 signal
    // objects spends most of its time preparing a diff nobody sees, and the
    // projection reads better in a failure message than an object dump.
    const signature = (m: Email): string => {
      const s = classifyEmail(m, profile);
      return `${s.security ? 1 : 0}${s.newsletter ? 1 : 0}${s.promotional ? 1 : 0}${
        s.urgentText ? 1 : 0
      }${s.needsAction ? 1 : 0}${s.finance ? 1 : 0}${s.codes ? 1 : 0}${
        s.shipping ? 1 : 0
      }${s.travel ? 1 : 0}${s.events ? 1 : 0}${s.social ? 1 : 0}${s.longRead ? 1 : 0}@${
        s.spamLikelihood
      }/${s.importanceScore}`;
    };
    for (const message of DEMO_EMAILS) {
      expect(signature(message), message.gmailId).toBe(signature(message));
    }
  });

  it("puts the seeded security notice in the security bucket", () => {
    const alert = DEMO_EMAILS.find((m) => m.gmailId === "demo-security-1")!;
    const signals = classifyEmail(alert, profile);
    expect(signals.security).toBe(true);
    // 50 plus security plus urgency, and nothing else: the sender is a first-time
    // contact rather than a quiet one, so no penalty applies. Exact, because a
    // seeded score that drifts silently is the failure this file is for.
    expect(signals.importanceScore).toBe(
      50 + STANDARD_WEIGHTS.security + STANDARD_WEIGHTS.urgency,
    );
    expect(profile.quietSenders).not.toContain(alert.sender);
  });

  it("puts the seeded code in codes, not security", () => {
    const code = DEMO_EMAILS.find((m) => m.gmailId === "demo-codes-1")!;
    const signals = classifyEmail(code, profile);
    expect(signals.codes).toBe(true);
    expect(signals.security).toBe(false);
    // Codes pay nothing, so this lands on the base score with nothing added.
    expect(signals.importanceScore).toBe(50);
  });

  it("flags the seeded phishing as unsafe", () => {
    const phish = DEMO_EMAILS.find((m) => m.gmailId === "demo-security-2")!;
    const signals = classifyEmail(phish, profile);
    // 0.1 for the digits in the lookalike domain, 0.3 for the phishing phrasing,
    // 0.45 for the coercion that follows it.
    expect(signals.spamLikelihood).toBeCloseTo(0.85, 10);
    expect(isUnsafe(signals)).toBe(true);
    // …and the safety valve drags its score below the Important threshold, which
    // is the whole point of computing spam before importance.
    expect(signals.importanceScore).toBe(41);
  });

  it("flags the empty-subject message as unsafe", () => {
    const empty = DEMO_EMAILS.find((m) => m.gmailId === "demo-spam-1")!;
    // 0.2 for the empty subject, 0.08 for the bare call to action, 0.15 for the
    // one scam phrase. The subject is what makes the difference here: the same
    // body with one is a real message.
    const signals = classifyEmail(empty, profile);
    expect(signals.spamLikelihood).toBeCloseTo(0.43, 10);
    expect(isUnsafe(signals)).toBe(true);
  });

  it("scores every junk fixture the seed ships, not just the inbox one", () => {
    // The seed files four junk fixtures in spam and one in the bin, so a test
    // that only looks at the inbox sees one of the five. Their scores are all
    // hand-derived and all clear the threshold for a different reason.
    const expected: [string, number][] = [
      // shouty subject, three scam phrases and a bare call to action
      ["demo-spam-2", 0.627],
      // credential demand plus data destruction
      ["demo-spam-3", 0.75],
      // shouty subject, one scam phrase, urgency wording
      ["demo-spam-4", 0.427],
      // shouty subject and four scam phrases
      ["demo-trash-1", 0.507],
    ];
    for (const [id, spam] of expected) {
      const message = DEMO_EMAILS.find((m) => m.gmailId === id)!;
      expect(classifyEmail(message, profile).spamLikelihood, id).toBeCloseTo(spam, 10);
      expect(isUnsafe(classifyEmail(message, profile)), id).toBe(true);
    }
  });

  it("reaches the long-read threshold with the long fixture", () => {
    const long = DEMO_EMAILS.find((m) => m.gmailId === "demo-long-1")!;
    expect(classifyEmail(long, profile).longRead).toBe(true);
    // …and it is over the threshold by a margin, not exactly on it, so a
    // threshold raised by one word would not flip this fixture to short.
    expect(long.body.split(/\s+/).length).toBeGreaterThan(250);
    // A short one stays short, which is the control.
    const short = DEMO_EMAILS.find((m) => m.gmailId === "demo-action-4")!;
    expect(classifyEmail(short, profile).longRead).toBe(false);
  });

  it("does not treat the caps-but-legitimate urgent mail as spam", () => {
    const urgent = DEMO_EMAILS.find((m) => m.gmailId === "demo-urgent-1")!;
    const signals = classifyEmail(urgent, profile);
    expect(signals.spamLikelihood).toBe(0);
    // …while still reading as urgent and as an ask, and scoring well above the
    // Important threshold. Zero here is a judgement, not a blank.
    expect(signals.urgentText).toBe(true);
    expect(signals.needsAction).toBe(true);
    expect(signals.importanceScore).toBeGreaterThanOrEqual(56);
  });
});
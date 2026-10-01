import { describe, expect, it } from "vitest";
import { classifyEmail, contentBag, inboxSearchBag, senderRankBonus } from "./classify";
import { EMPTY_PROFILE, buildUserProfile, tierFor, trashBiasFor } from "../model/profile";
import { UNSAFE_THRESHOLD, isUnsafe } from "../model/signals";
import { STANDARD_WEIGHTS } from "./weights";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import type { Email } from "../model/email";

/** A message with only what a test cares about. */
function email(over: Partial<Email> = {}): Email {
  return {
    id: 1,
    gmailId: "g1",
    sender: "someone@example.com",
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

describe("classifyEmail — security", () => {
  it("fires on a security alert", () => {
    const signals = classifyEmail(
      email({ subject: "Security alert: unusual sign-in attempt", body: "We noticed a login." }),
      EMPTY_PROFILE,
    );
    expect(signals.security).toBe(true);
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
  });

  it("does not fire on 'authentication' inside 'authentication code'", () => {
    const signals = classifyEmail(
      email({ subject: "Sign-in", body: "Your authentication code is 5521." }),
      EMPTY_PROFILE,
    );
    expect(signals.security).toBe(false);
  });

  it("does fire on a failed authentication", () => {
    const signals = classifyEmail(
      email({ subject: "Sign-in blocked", body: "Authentication failed on three attempts." }),
      EMPTY_PROFILE,
    );
    expect(signals.security).toBe(true);
  });

  it("is not triggered by the sender address alone", () => {
    // A mailbox called `security-alerts@` is not a security notice. The address
    // is excluded from the haystack precisely so this holds.
    const signals = classifyEmail(
      email({ sender: "security@bank.example", subject: "Your statement", body: "Nothing to report." }),
      EMPTY_PROFILE,
    );
    expect(signals.security).toBe(false);
  });
});

describe("classifyEmail — keyword matching is word-bounded", () => {
  it("'otp' does not fire inside 'hotel'", () => {
    const signals = classifyEmail(
      email({ subject: "Your hotel booking", body: "Your hotel is confirmed for Friday." }),
      EMPTY_PROFILE,
    );
    expect(signals.codes).toBe(false);
  });

  it("'free' does not make a message promotional", () => {
    const signals = classifyEmail(
      email({ subject: "Freedom of information request", body: "Your request is under consideration." }),
      EMPTY_PROFILE,
    );
    expect(signals.promotional).toBe(false);
  });

  it("'amount due' does not fire inside 'amounts reduce'", () => {
    // The past-due tells were "past due", "overdue", "late fee", "amount due" —
    // all phrases. Bare "due" would match "reduce", "introduce" and "produce",
    // which is most of the English language.
    const signals = classifyEmail(
      email({ subject: "Introducing our new service", body: "We produce reports weekly." }),
      EMPTY_PROFILE,
    );
    expect(signals.finance).toBe(false);
  });

  it("still matches a real bill", () => {
    const signals = classifyEmail(
      email({ subject: "Invoice 2026-0412", body: "Amount due: £60.40 within 14 days." }),
      EMPTY_PROFILE,
    );
    expect(signals.finance).toBe(true);
  });

  it("'post' does not fire inside 'postpone'", () => {
    const signals = classifyEmail(
      email({ subject: "Meeting postpone", body: "The meeting postpone to next week." }),
      EMPTY_PROFILE,
    );
    expect(signals.social).toBe(false);
  });

  it("but the real phrase still matches", () => {
    const signals = classifyEmail(
      email({ subject: "New follower", body: "Someone new is following you." }),
      EMPTY_PROFILE,
    );
    expect(signals.social).toBe(true);
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
});

describe("classifyEmail — bulk mail", () => {
  it("needs two unsubscribe-style tells, or Gmail's own label", () => {
    const one = classifyEmail(
      email({ subject: "Our newsletter", body: "We thought you would like this." }),
      EMPTY_PROFILE,
    );
    expect(one.newsletter).toBe(false);

    const two = classifyEmail(
      email({ subject: "Our newsletter", body: "Unsubscribe any time. View in browser." }),
      EMPTY_PROFILE,
    );
    expect(two.newsletter).toBe(true);
  });

  it("trusts Gmail's category outright", () => {
    const signals = classifyEmail(
      email({ subject: "Issue 412", body: "Short.", category: "newsletter" }),
      EMPTY_PROFILE,
    );
    expect(signals.newsletter).toBe(true);
  });
});

describe("classifyEmail — needsAction", () => {
  it("fires on an explicit ask", () => {
    const signals = classifyEmail(
      email({ subject: "Re: the plan", body: "Could you send the two slow queries again?" }),
      EMPTY_PROFILE,
    );
    expect(signals.needsAction).toBe(true);
  });

  it("does not fire on 'verify your email', which is a link not a request", () => {
    // Bare "verify" was in the pattern list and matched every verification
    // mail, which put the entire account-recovery flow into "Action needed".
    const signals = classifyEmail(
      email({ subject: "Verify your email", body: "Click to verify your email address." }),
      EMPTY_PROFILE,
    );
    expect(signals.needsAction).toBe(false);
  });

  it("does not fire on a newsletter asking for feedback", () => {
    const signals = classifyEmail(
      email({
        subject: "The Weekly",
        body: "Let me know what you think. Unsubscribe · View in browser.",
        category: "newsletter",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.needsAction).toBe(false);
  });
});

describe("classifyEmail — spam likelihood", () => {
  it("is very high for an empty subject and body", () => {
    const signals = classifyEmail(email({ subject: "", body: "" }), EMPTY_PROFILE);
    expect(signals.spamLikelihood).toBeGreaterThanOrEqual(UNSAFE_THRESHOLD);
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
    expect(signals.spamLikelihood).toBeGreaterThanOrEqual(0.3);
  });

  it("crosses the threshold when phishing phrasing is corroborated", () => {
    // The digits in the domain are the second tell. Together they are the
    // difference between a real alert from a real bank and a lookalike.
    const signals = classifyEmail(
      email({
        sender: "no-reply@github-security227.com",
        subject: "Your account will be suspended",
        body: "Your account has been compromised. Click here to verify your password.",
      }),
      EMPTY_PROFILE,
    );
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
    // so it is scored additively rather than folded into the binary test.
    const signals = classifyEmail(
      email({
        sender: "service@account-verify.example",
        subject: "Your account will be suspended",
        body: "Your account will be suspended unless you verify your password immediately.\n\nFailure to comply within 24 hours will result in permanent closure of your account and all associated data will be removed.",
      }),
      EMPTY_PROFILE,
    );
    expect(isUnsafe(signals)).toBe(true);
  });

  it("is not raised by a genuine notice about a delinquent account", () => {
    // The other half of that fix, and the reason the coercion patterns require a
    // *demand* alongside the threat. A bank warning that an unpaid account will
    // be closed is real, common, and must not be filed as phishing — otherwise
    // the Unsafe bucket cries wolf, which is the only way to make it useless.
    const signals = classifyEmail(
      email({
        sender: "billing@bank.example",
        subject: "Your account will be closed if the balance remains unpaid",
        body: "Your account may be suspended if the minimum balance is not maintained. Please pay the outstanding amount within 7 days to avoid closure.",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.spamLikelihood).toBeLessThan(UNSAFE_THRESHOLD);
  });

  it("is not raised by an earnest urgent letter about an expiring document", () => {
    // Counted as a case because the coercion weight is additive: two worrying
    // phrasings in one real letter must not add up to unsafe on volume of worry.
    const signals = classifyEmail(
      email({
        sender: "registry@company.example",
        subject: "Action required: your visa document expires soon",
        body: "Please confirm your details within 14 days. Failure to comply will result in your registration being cancelled. We would rather help you avoid this.",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.spamLikelihood).toBeLessThan(UNSAFE_THRESHOLD);
  });

  it("recognises the commonest account-security notice of all", () => {
    // The table had "unrecognized device" — which almost nobody writes, because
    // a service calling your own phone unrecognised reads as a bug to the person
    // receiving it — and missed the form every major service actually uses.
    const signals = classifyEmail(
      email({
        sender: "noreply@dropbox.com",
        subject: "We noticed a new device signed in to your account",
        body: "A new device signed in to your account. If this was you, you can dismiss this notice. If not, please review your sign-in history.",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.security).toBe(true);
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
    expect(welcome.spamLikelihood).toBeLessThan(UNSAFE_THRESHOLD);
  });

  it("is not raised by a click-here link with no credential language", () => {
    // Every newsletter has one of these. Treating it as phishing taught users
    // to ignore the Unsafe bucket, which is the one that must never cry wolf.
    const signals = classifyEmail(
      email({
        sender: "digest@news.example",
        subject: "This week in engineering",
        body: "Read more. Click here for the full article. Unsubscribe below.",
      }),
      EMPTY_PROFILE,
    );
    expect(signals.spamLikelihood).toBeLessThan(UNSAFE_THRESHOLD);
  });

  it("is raised by a shouty subject with repeated exclamation marks", () => {
    const signals = classifyEmail(
      email({ subject: "CONGRATULATIONS!!! YOU HAVE WON!!!", body: "Claim your prize." }),
      EMPTY_PROFILE,
    );
    expect(signals.spamLikelihood).toBeGreaterThan(0.1);
  });

  it("is not raised by a shouty subject with only one exclamation mark", () => {
    const signals = classifyEmail(
      email({
        sender: "dana@northwind.example",
        subject: "URGENT: THE MIGRATION WINDOW MOVED",
        body: "It is now Thursday.",
      }),
      EMPTY_PROFILE,
    );
    // The `!!` requirement is what separates a real alert from a marketer.
    // Without it, every caps subject from a colleague became spam. (The sender
    // is a real-looking address because `example.com` is itself a spam tell —
    // mixing the two would have hidden which one was under test.)
    expect(signals.spamLikelihood).toBeLessThan(0.1);
  });

  it("is raised by a reserved example.com sender, which is a fixture tell", () => {
    const signals = classifyEmail(
      email({ sender: "someone@example.com", subject: "Hello", body: "Hi there." }),
      EMPTY_PROFILE,
    );
    // `example.com` is the documentation domain. Real mail from it is a seed
    // or a test, and the classifier is allowed to know that.
    expect(signals.spamLikelihood).toBeGreaterThan(0.1);
  });

  it("stacks per distinct scam phrase, to a ceiling", () => {
    const many = classifyEmail(
      email({
        subject: "",
        body: "claim your prize you have won free money act now exclusive deal buy now call now free gift earn money work from home cash bonus increase your",
      }),
      EMPTY_PROFILE,
    );
    expect(many.spamLikelihood).toBeLessThanOrEqual(1);
    expect(many.spamLikelihood).toBeGreaterThan(0.5);
  });

  it("is raised by repeated discards of the same sender", () => {
    const profile = buildUserProfile(
      [email({ sender: "deals@shop.example" })],
      Array.from({ length: 12 }, () => ({ sender: "deals@shop.example" })),
    );
    const biased = classifyEmail(
      email({ sender: "deals@shop.example", subject: "Hello", body: "Just saying hello." }),
      profile,
    );
    const neutral = classifyEmail(
      email({ sender: "someone@else.example", subject: "Hello", body: "Just saying hello." }),
      profile,
    );
    expect(biased.spamLikelihood).toBeGreaterThan(neutral.spamLikelihood);
  });

  it("caps trash bias so one sender cannot dominate", () => {
    const profile = buildUserProfile(
      [email({ sender: "deals@shop.example" })],
      Array.from({ length: 500 }, () => ({ sender: "deals@shop.example" })),
    );
    // The raw ratio is 0.99; without the cap this would be 0.5, which is more
    // than half of every score the classifier produces.
    expect(trashBiasFor(profile, "deals@shop.example")).toBeLessThanOrEqual(0.35);
  });
});

describe("classifyEmail — importance", () => {
  it("puts a starred message above an identical unstarred one", () => {
    const starred = classifyEmail(
      email({ starred: true, subject: "Notes", body: "Some notes." }),
      EMPTY_PROFILE,
    );
    const plain = classifyEmail(email({ subject: "Notes", body: "Some notes." }), EMPTY_PROFILE);
    expect(starred.importanceScore).toBe(plain.importanceScore + STANDARD_WEIGHTS.starBoost);
  });

  it("penalises a newsletter", () => {
    const newsletter = classifyEmail(
      email({ subject: "The Weekly", body: "Unsubscribe. View in browser.", category: "newsletter" }),
      EMPTY_PROFILE,
    );
    const plain = classifyEmail(email({ subject: "Hello", body: "Hi." }), EMPTY_PROFILE);
    expect(newsletter.importanceScore).toBeLessThan(plain.importanceScore);
  });

  it("pays for a signature request, which is the pattern 'sign' alone missed", () => {
    const signals = classifyEmail(
      email({ subject: "Contract", body: "Please sign the attached agreement at your convenience." }),
      EMPTY_PROFILE,
    );
    expect(signals.needsAction).toBe(true);
  });

  it("does not fire 'sign in' as a signature request", () => {
    const signals = classifyEmail(
      email({ subject: "Sign in to your account", body: "Sign in here to continue." }),
      EMPTY_PROFILE,
    );
    expect(signals.needsAction).toBe(false);
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
});

describe("senderRankBonus", () => {
  const profile = {
    trashBiasBySender: {},
    topSenders: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"],
    quietSenders: [],
    firstTimeSenders: [],
  };

  it("gives the top sender the full boost", () => {
    expect(senderRankBonus(profile, "a@x.com", 18)).toBe(18);
  });

  it("scales down by tier", () => {
    expect(senderRankBonus(profile, "b@x.com", 18)).toBe(12);
    expect(senderRankBonus(profile, "d@x.com", 18)).toBe(6);
  });

  it("gives an unranked sender nothing", () => {
    expect(senderRankBonus(profile, "z@x.com", 18)).toBe(0);
  });

  it("agrees with the tier function", () => {
    expect(tierFor(profile, "a@x.com")).toBe(0);
    expect(tierFor(profile, "c@x.com")).toBe(1);
    expect(tierFor(profile, "e@x.com")).toBe(2);
    expect(tierFor(profile, "z@x.com")).toBe(3);
  });
});

describe("the demo mailbox", () => {
  const profile = buildUserProfile(DEMO_EMAILS, DEMO_TRASH);

  it("classifies every message without throwing", () => {
    for (const message of DEMO_EMAILS) {
      expect(() => classifyEmail(message, profile)).not.toThrow();
    }
  });

  it("puts the seeded security notice in the security bucket", () => {
    const alert = DEMO_EMAILS.find((m) => m.gmailId === "demo-security-1")!;
    expect(classifyEmail(alert, profile).security).toBe(true);
  });

  it("puts the seeded code in codes, not security", () => {
    const code = DEMO_EMAILS.find((m) => m.gmailId === "demo-codes-1")!;
    const signals = classifyEmail(code, profile);
    expect(signals.codes).toBe(true);
    expect(signals.security).toBe(false);
  });

  it("flags the seeded phishing as unsafe", () => {
    const phish = DEMO_EMAILS.find((m) => m.gmailId === "demo-security-2")!;
    const signals = classifyEmail(phish, profile);
    expect(signals.spamLikelihood).toBeGreaterThanOrEqual(UNSAFE_THRESHOLD);
    expect(isUnsafe(signals)).toBe(true);
  });

  it("flags the empty-subject message as unsafe", () => {
    const empty = DEMO_EMAILS.find((m) => m.gmailId === "demo-spam-1")!;
    expect(classifyEmail(empty, profile).spamLikelihood).toBeGreaterThanOrEqual(UNSAFE_THRESHOLD);
  });

  it("reaches the long-read threshold with the long fixture", () => {
    const long = DEMO_EMAILS.find((m) => m.gmailId === "demo-long-1")!;
    expect(classifyEmail(long, profile).longRead).toBe(true);
  });

  it("does not treat the caps-but-legitimate urgent mail as spam", () => {
    const urgent = DEMO_EMAILS.find((m) => m.gmailId === "demo-urgent-1")!;
    expect(classifyEmail(urgent, profile).spamLikelihood).toBeLessThan(UNSAFE_THRESHOLD);
  });
});

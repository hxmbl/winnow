/**
 * The classifier's vocabulary: keyword tables and regexes.
 *
 * Two structural rules hold across every table:
 *
 *   1. **No vendor names.** A bucket is a *kind* of mail, so it survives a sender
 *      change. (Vendor names are fine in `SOCIAL_DOMAINS`, where the domain *is*
 *      the signal.)
 *   2. **No overlap between gated tables.** `codes` is gated on `!security`, so a
 *      phrase in both `securityKeywords` and `codesKeywords` makes the codes entry
 *      unreachable. Tests assert the tables do not overlap.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Classification/Heuristics.swift`.
 */

import { compile, KeywordTable } from "./text";

// ── Security ────────────────────────────────────────────────────────────────

/**
 * Something is *wrong* with the account.
 *
 * Deliberately excludes the code half of a login notice — "Your OTP is 1234" is a
 * copyable code, not an alarm, and belongs in `codesKeywords` — and bare
 * "authentication", which fires inside "authentication code".
 */
export const securityKeywords = new KeywordTable([
  "verify your account",
  "security alert",
  "unauthorized",
  "suspicious activity",
  "breach",
  "breached",
  "reset your password",
  "reset password",
  "two-factor",
  "2fa",
  "oauth",
  "login attempt",
  "authentication failed",
  "authentication error",
  "failed authentication",
  "unusual sign-in",
  "unusual sign in",
  "unrecognized device",
  // The new-device notice is how Dropbox, Google, Apple and most banks word the
  // commonest account-security event there is. Narrower than it looks: "signed in
  // to your account" alone fires on the *welcome-back* mail sent after a legitimate
  // sign-in, so the entries below require the *newness*, and "sign-in history" is
  // the action a real alert offers.
  "new device signed in",
  "new device has signed in",
  "sign-in history",
]);

// ── Bulk mail ───────────────────────────────────────────────────────────────

/**
 * Sent on a list. Two distinct hits are required before this fires on
 * wording alone — a single "unsubscribe" link is normal in transactional mail.
 */
export const newsletterKeywords = new KeywordTable([
  "unsubscribe",
  "newsletter",
  "mailing list",
  "weekly digest",
  "view in browser",
  "email preferences",
  "manage preferences",
]);

// ── Urgency ─────────────────────────────────────────────────────────────────

export const urgentKeywords = new KeywordTable([
  "urgent",
  "asap",
  "immediately",
  "expires tonight",
  "last chance",
  "critical",
  "time sensitive",
  "action required",
  "deadline",
  "needs your approval",
]);

// ── Spam phrasing ───────────────────────────────────────────────────────────

/**
 * Classic scam wording, stacking per distinct hit.
 *
 * Everyday words stay out on purpose — "Congratulations" and "unlimited" appear in
 * real benefit and bank notices, and junking those teaches the user to ignore the
 * Unsafe bucket, which must never cry wolf.
 */
export const spamKeywords = new KeywordTable([
  "claim your prize",
  "you have won",
  "free money",
  "act now",
  "exclusive deal",
  "buy now",
  "call now",
  "free gift",
  "earn money",
  "work from home",
  "cash bonus",
  "increase your",
]);

// ── Transactional ───────────────────────────────────────────────────────────

/**
 * Invoices, receipts, billing, payouts.
 *
 * No bare "payment", "total" or "balance" — those appear in marketing copy
 * ("total savings", "balance your portfolio") far more often than in a bill.
 * The `financeRegex` below catches real bills that word themselves otherwise.
 */
export const financeKeywords = new KeywordTable([
  "invoice",
  "receipt",
  "payment received",
  "payment confirmation",
  "order confirmation",
  "billing",
  "statement",
  "subscription renewed",
  "auto-renew",
  "your order",
  "refund",
  "wire transfer",
  "direct deposit",
  "payout",
  "your bill",
  "bill is ready",
  "amount due",
  "credit score",
]);

// ── Codes ───────────────────────────────────────────────────────────────────

/**
 * One-time codes the user is meant to copy.
 *
 * None of these may appear in `securityKeywords` — `codes` is gated on
 * `!securitySignal`, so an overlap would make this table unreachable.
 */
export const codesKeywords = new KeywordTable([
  "one-time code",
  "one time code",
  "verification code",
  "security code",
  "sign-in code",
  "sign in code",
  "login code",
  "auth code",
  "authentication code",
  "confirmation code",
  "verification pin",
  "one-time passcode",
  "otp",
  "passcode",
  "single-use code",
]);

// ── Shipping ────────────────────────────────────────────────────────────────

/** Package and delivery notices. Phrases only — see the header note. */
export const shippingKeywords = new KeywordTable([
  "tracking number",
  "tracking update",
  "your package",
  "out for delivery",
  "has shipped",
  "has been shipped",
  "shipping confirmation",
  "delivery date",
  "delivery scheduled",
  "delivery attempt",
  "delivery was",
  "status of your order",
  "courier",
  "parcel",
  "dispatch confirmation",
  "is on its way",
  "arriving tomorrow",
]);

// ── Travel ──────────────────────────────────────────────────────────────────

export const travelKeywords = new KeywordTable([
  "boarding pass",
  "flight",
  "itinerary",
  "hotel",
  "reservation",
  "booking confirmation",
  "car rental",
  "airport",
  "departure gate",
  "layover",
  "check-in",
  "check in",
  "arrival time",
  "trip details",
]);

// ── Events ──────────────────────────────────────────────────────────────────

/**
 * Invitations and calendar events. Bare "event" and "meeting" are far too
 * common to be a tell — they appear in newsletters and in ordinary prose.
 */
export const eventsKeywords = new KeywordTable([
  "calendar invite",
  "you're invited",
  "you are invited",
  "invitation",
  "save the date",
  "webinar",
  "meetup",
  "rsvp",
  "workshop",
  "conference",
  "register for",
  "reserve your spot",
  "roundtable",
]);

// ── Social ──────────────────────────────────────────────────────────────────

/** Social notifications by phrasing. */
export const socialKeywords = new KeywordTable([
  "mentioned you",
  "commented on",
  "sent you a message",
  "new follower",
  "friend request",
  "connection request",
  "replied to your",
  "liked your",
  "tagged you",
  "invited you to join",
  "you have a new",
  "added to your",
]);

/**
 * Social platforms by sender domain.
 *
 * The one place a vendor name is allowed: a mention from a platform *is* the
 * signal, and no phrasing covers it. Checked against both the envelope sender
 * and the display address, because a platform often sends from a relay.
 */
export const SOCIAL_DOMAINS: readonly string[] = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "threads.net",
  "reddit.com",
  "pinterest.com",
  "tiktok.com",
  "snapchat.com",
  "discord.com",
  "youtube.com",
  "whatsapp.com",
  "telegram.org",
];

// ── Regexes ─────────────────────────────────────────────────────────────────

/** Marketing copy. The promotional signal, alongside Gmail's own label. */
export const promoRegex = compile(
  "\\b\\d+%\\s*off\\b|\\bflash sale\\b|\\blimited time\\b|\\bfree shipping\\b|\\btoday only\\b|\\bpromo(?: code)?\\b|\\bprice drop\\b|\\bfree delivery\\b|\\boffer ends\\b|\\bdon't miss out\\b",
);

/**
 * Real phishing copy.
 *
 * "Click here" only counts next to account or credential language — every
 * newsletter has a click-here link. "Unusual sign-in" is deliberately *not* here:
 * banks send it about genuine fraud, and treating it as phishing would bury the
 * alert the user needs.
 */
export const phishingRegex = compile(
  "\\b(?:account has been compromised|verify your password|suspended account|click here.{0,80}(?:password|account|verify|identity|login|credential))\\b",
);

/**
 * Coercion: a deadline or a threat, wrapped around a demand.
 *
 * Separate from `phishingRegex` rather than folded into it, because that test is
 * *binary* — one hit is 0.3 whether it matched one phrase or five — so folding
 * coercion in changed nothing for the message that already matched "verify your
 * password". What makes a campaign worse than a bare credential demand is the
 * threat attached to it, and that deserves to score above the threshold on its own.
 *
 * Every alternative requires a *demand* alongside the threat, which keeps genuine
 * enforcement notices out: misfiling those is how the Unsafe bucket learns to cry
 * wolf.
 */
export const coercionRegex = compile(
  [
    // A credential demand carrying a deadline or a condition. The demand is
    // required in every alternative — a bare "your account will be suspended" is a
    // real bank notice, and treating it as coercion would misfile genuine
    // enforcement mail.
    "(?:verif|confirm|update|renew)\\w* your (?:password|account|credentials|identity|access).{0,80}(?:hour|minute|day|immediately|unless|expire)",
    "unless you verif",
    // Data destruction as the stated consequence. No institution phrases it this
    // way about an account the user is already in.
    "(?:all|your) (?:associated )?(?:data|records|files) will be (?:removed|deleted|deactivated)",
    // Credential stuffing: several failures in a row. Real alerts say "unusual";
    // campaigns say "multiple".
    "(?:unauthori[sz]ed|multiple|failed|unrecogni[sz]ed) (?:sign-?in|log-?in|access) attempts?",
    // A countdown stated on its own, as a subject line does.
    "(?:hour|minute)s? to (?:verif|confirm|respond)",
    // "Failure to comply" only counts when the stated consequence is the account
    // itself. "Failure to comply will result in your registration being
    // cancelled" is a real registrar email and does not match — which is the
    // whole reason the consequence is spelled out rather than left as `.{0,50}`.
    "failure to (?:comply|verify|confirm).{0,60}(?:result in your account|account (?:will be )?(?:suspend|clos|delet|terminat))",
  ].join("|"),
);

/** Generic CTA. A weak tell on its own; ignored when `phishingRegex` fired. */
export const clickHereRegex = compile("\\bclick here\\b");

/** Bills that word themselves outside the keyword list: "Your May wireless bill". */
export const financeRegex = compile("\\b(?:total due|your .{0,24}\\bbill)\\b");

/**
 * Wording that asks something of the reader.
 *
 * Bare "verify" and bare "sign" are excluded — they match "verify your email"
 * and "sign in", which are the *links* in a security mail, not requests to the
 * user. The third pattern catches an actual signature request.
 */
export const needsActionRegexes = [
  compile("\\b(?:appointment|renew|check-?in|register|approval)\\b"),
  compile("\\b(?:bill|payment|invoice)\\s+is\\s+due\\b"),
  compile("\\b(?:please\\s+sign|sign\\s+(?:the|this|here)|signature)\\b"),
] as const;

/**
 * Asks directed at the reader, stricter than the `needsAction` net above, so
 * the "Action needed" bucket stays high-signal.
 */
export const replyRequestRegex = compile(
  "\\b(?:let me know|please (?:confirm|review|approve|send|reply|respond)|could you|can you|would you|rsvp|your (?:thoughts|feedback|input))\\b",
);

/** A bare email address, used to tell a real sender from a display string. */
export const ADDRESS_REGEX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ── Word counts ─────────────────────────────────────────────────────────────

/** Body length in words. Gates the "Long reads" bucket. */
export function bodyWordCount(body: string): number {
  const trimmed = body.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Whether a subject reads as shouting: mostly capitals, and more than one
 * exclamation mark.
 *
 * Counted over ASCII letters only, so a French or Turkish subject does not look
 * shouted. One pass and no regexes — this runs per message on every classification.
 */
export function isShoutySubject(subject: string): boolean {
  let upper = 0;
  let alpha = 0;
  for (let i = 0; i < subject.length; i += 1) {
    const code = subject.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      upper += 1;
      alpha += 1;
    } else if (code >= 97 && code <= 122) {
      alpha += 1;
    }
  }
  return alpha > 5 && upper / alpha > 0.55 && subject.includes("!!");
}

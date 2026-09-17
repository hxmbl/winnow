import Foundation

// MARK: - Compiled matchers
//
// Classification is regex-heavy, so every pattern below is compiled exactly
// once at startup. The naive version rebuilt a regex inside the matching loop,
// which dominated profile/classify time (thousands of compilations per inbox).

/// Case-insensitive regex from a static literal pattern, built once at startup.
nonisolated func regex(_ pattern: String) -> NSRegularExpression {
    try! NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
}

nonisolated func matches(_ expression: NSRegularExpression, in string: String) -> Bool {
    expression.firstMatch(in: string, range: NSRange(location: 0, length: string.utf16.count)) != nil
}

/// Whole-phrase matcher with word boundaries so short tells like "otp" cannot
/// fire inside longer words. Whitespace runs in the phrase match any gap.
struct PhraseMatcher {
    let expression: NSRegularExpression

    nonisolated init(_ phrase: String) {
        let escaped = phrase.split(whereSeparator: \.isWhitespace)
            .map { NSRegularExpression.escapedPattern(for: String($0)) }
            .joined(separator: "\\s+")
        expression = try! NSRegularExpression(pattern: "\\b\(escaped)\\b", options: [.caseInsensitive])
    }

    nonisolated func matches(_ haystack: String) -> Bool {
        expression.firstMatch(in: haystack, range: NSRange(location: 0, length: haystack.utf16.count)) != nil
    }
}

/// A keyword list compiled to matchers once. `any` short-circuits on the first
/// hit; `count` tallies distinct phrases present.
struct KeywordTable {
    private let matchers: [PhraseMatcher]

    nonisolated init(_ phrases: [String]) {
        self.matchers = phrases.map(PhraseMatcher.init)
    }

    nonisolated func any(_ haystack: String) -> Bool {
        matchers.contains { $0.matches(haystack) }
    }

    nonisolated func count(_ haystack: String) -> Int {
        matchers.filter { $0.matches(haystack) }.count
    }
}

// MARK: - Keyword heuristics

/// Security/account tells → the `.security` signal.
nonisolated let securityKeywords = KeywordTable([
    "verify your account", "security alert", "unauthorized", "suspicious activity",
    "breach", "breached", "reset your password", "reset password", "one-time passcode", "otp",
    "two-factor", "2fa", "oauth", "authentication", "login attempt",
    "unusual sign-in", "unusual sign in", "unrecognized device",
])
/// Bulk-mail tells → the `.newsletter` signal (fires at ≥ 2 hits, or via `type`).
nonisolated let newsletterKeywords = KeywordTable([
    "unsubscribe", "newsletter", "mailing list", "weekly digest", "view in browser",
    "email preferences", "manage preferences",
])
/// Time-pressure language → the `.urgentText` signal.
nonisolated let urgentKeywords = KeywordTable([
    "urgent", "asap", "immediately", "expires tonight", "last chance", "critical",
    "time sensitive", "action required", "deadline", "needs your approval",
])
/// Classic scam phrasing → raises `spamLikelihood` (stacks per distinct hit).
/// Everyday words like "congratulations" / "unlimited" / "no cost" stay out so
/// bank notices and benefits mail are not treated as junk.
nonisolated let spamKeywords = KeywordTable([
    "claim your prize", "you have won", "free money", "act now",
    "exclusive deal", "buy now", "call now", "free gift", "earn money", "work from home",
    "cash bonus", "increase your",
])
/// Transactional mail → the `.finance` signal (gated against security/promo).
nonisolated let financeKeywords = KeywordTable([
    "invoice", "receipt", "payment received", "payment confirmation", "order confirmation",
    "billing", "statement", "subscription renewed", "auto-renew", "your order",
    "refund", "wire transfer", "direct deposit", "payout", "your bill", "bill is ready",
    "amount due", "credit score",
])
/// One-time login / verification codes → the `.codes` signal. Deliberately
/// narrower than security — a code is copyable, not an alarm.
nonisolated let codesKeywords = KeywordTable([
    "one-time code", "one time code", "verification code", "security code",
    "sign-in code", "sign in code", "login code", "auth code", "authentication code",
    "confirmation code", "verification pin", "one-time passcode", "otp", "passcode",
    "single-use code",
])
/// Package / delivery notifications → the `.shipping` signal.
nonisolated let shippingKeywords = KeywordTable([
    "tracking number", "tracking update", "your package", "out for delivery",
    "has shipped", "has been shipped", "shipping confirmation", "delivery date",
    "delivery scheduled", "delivery attempt", "delivery was", "status of your order",
    "courier", "parcel", "dispatch confirmation", "is on its way", "arriving tomorrow",
])
/// Flight/hotel/itinerary correspondence → the `.travel` signal.
nonisolated let travelKeywords = KeywordTable([
    "boarding pass", "flight", "itinerary", "hotel", "reservation",
    "booking confirmation", "car rental", "airport", "departure gate",
    "layover", "check-in", "check in", "arrival time", "trip details",
])
/// Invitations and calendar events → the `.events` signal. Precise phrases only —
/// bare "event" is too common to be a useful tell.
nonisolated let eventsKeywords = KeywordTable([
    "calendar invite", "you're invited", "you are invited", "invitation",
    "save the date", "webinar", "meetup", "rsvp", "workshop", "conference",
    "register for", "reserve your spot", "roundtable",
])
/// Social-platform notifications → the `.social` signal (keyword phrasing).
nonisolated let socialKeywords = KeywordTable([
    "mentioned you", "commented on", "sent you a message", "new follower",
    "friend request", "connection request", "replied to your", "liked your",
    "tagged you", "invited you to join", "you have a new", "added to your",
])
/// Social platforms matched by sender domain (e.g. `no-reply@linkedin.com`).
nonisolated let socialDomains: [String] = [
    "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
    "threads.net", "reddit.com", "pinterest.com", "tiktok.com", "snapchat.com",
    "discord.com", "youtube.com", "whatsapp.com", "telegram.org",
]

// MARK: - Regex heuristics

nonisolated let promoRegex = regex(
    #"\b\d+%\s*off\b|\bflash sale\b|\blimited time\b|\bfree shipping\b|\btoday only\b|\bpromo(?: code)?\b|\bprice drop\b|\bfree delivery\b|\boffer ends\b|\bdon't miss out\b"#
)
/// Real phishing copy. "Click here" alone is too common in legit mail — it only
/// counts here when it sits next to account/credential language. "Unusual
/// sign-in" is a security tell (see `securityKeywords`), not a spam tell: banks
/// send it for real.
nonisolated let phishingRegex = regex(
    #"\b(?:account has been compromised|verify your password|suspended account|click here.{0,80}(?:password|account|verify|identity|login|credential))\b"#
)
/// Generic CTA. Weak spam tell on its own; ignored when `phishingRegex` already fired.
nonisolated let clickHereRegex = regex(#"\bclick here\b"#)
/// Bills whose wording doesn't hit the keyword list ("Your May wireless bill").
nonisolated let financeRegex = regex(#"\b(?:total due|your .{0,24}\bbill)\b"#)

nonisolated let needsActionRegexes: [NSRegularExpression] = [
    regex(#"\b(?:appointment|renew|check-?in|register|approval)\b"#),
    regex(#"\b(?:bill|payment|invoice)\s+is\s+due\b"#),
    // Bare "sign" / "verify" match "sign in" and "verify your email" CTAs.
    regex(#"\b(?:please\s+sign|sign\s+(?:the|this|here)|signature)\b"#),
]
/// Asks directed at the reader that imply a reply or task — stricter than the
/// broad `needsAction` keyword net, so "Action needed" stays high-signal.
nonisolated let replyRequestRegex = regex(
    #"\b(?:let me know|please (?:confirm|review|approve|send|reply|respond)|could you|can you|would you|rsvp|your (?:thoughts|feedback|input))\b"#
)

// MARK: - Text helpers

/// Lowercased concatenation of sender, subject, and body — search haystack.
nonisolated func wordBag(_ email: WinnowEmail) -> String {
    "\(email.sender) \(email.subject) \(email.body)".lowercased()
}

/// Subject + body only. Classification must not fire on the sender address
/// (`newsletter@…` is a mailbox, not a newsletter keyword).
nonisolated func contentBag(_ email: WinnowEmail) -> String {
    "\(email.subject) \(email.body)".lowercased()
}

/// True when the message comes from a social-platform address (mentions,
/// follows, and friend requests often arrive from a `no-reply@platform.com`).
nonisolated func matchesSocialDomain(_ email: WinnowEmail) -> Bool {
    let lines = [email.sender.lowercased(), (email.email ?? "").lowercased()]
    return lines.contains { line in
        socialDomains.contains { line.contains($0) }
    }
}

/// Word count of the body — gates the "Long reads" bucket.
nonisolated func bodyWordCount(_ email: WinnowEmail) -> Int {
    email.body.split(whereSeparator: \.isWhitespace).count
}

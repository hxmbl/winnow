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

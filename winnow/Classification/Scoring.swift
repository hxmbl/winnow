import Foundation

/// Intent signals and the weight each contributes to the "Smart Score" sort.
/// Positive weights mark mail that matters; negative ones mark noise.
///
/// This vocabulary is deliberately separate from the `Heuristics` keyword
/// tables: those drive the *learnable* importance engine (tunable weights),
/// while these fixed regexes keep Smart Score ordering stable while weights
/// drift. They overlap in spirit but not in tokens — do not "deduplicate" them
/// into one table without deciding which engine owns each phrase.
nonisolated private let intentRegexes: [(NSRegularExpression, Int)] = [
    (regex(#"\b(?:security|password|2fa|breach|unauthorized|suspicious|login attempt)\b"#), 15),
    (regex(#"\b(?:urgent|asap|deadline|time sensitive|action required|critical)\b"#), 12),
    (regex(#"\b(?:invoice|receipt|payment|billing|statement)\b"#), 8),
    (regex(#"\b(?:confirm|verify|appointment|reminder)\b"#), 6),
    (regex(#"\b(?:sale|discount|promo(?:tion)?|flash sale|\d+%\s*off)\b"#), -8),
    (regex(#"\b(?:unsubscribe|newsletter|weekly digest)\b"#), -10),
    // "due to arrive" is timing, not a past-due bill.
    (regex(#"\b(?:past due|overdue|late fee|due(?!\s+to\b))\b"#), 10),
]

/// Engagement bonus from a sender's standing in `topSenders`, expressed as a
/// fraction of `topBoost` per tier: tier 0 → full, tier 1 → ⅔, tier 2 → ⅓,
/// tier 3 → 0. Shared by the importance and smart-score formulas so they rank
/// senders consistently. Tier boundaries live in `UserProfile.tier(for:)`.
nonisolated func senderRankBonus(sender: String, profile: UserProfile, topBoost: Int = 18) -> Int {
    switch profile.tier(for: sender) {
    case 0: return topBoost
    case 1: return (topBoost * 2) / 3
    case 2: return topBoost / 3
    default: return 0
    }
}

/// Score (0–100) behind the "Smart Score" sort.
///
/// Deliberately independent of the learned `SignalWeights`: it ranks with the
/// fixed `intentRegexes`, so ordering stays stable while tuned weights drift.
/// Spam likelihood *is* honored — unsafe mail is dragged down so the Smart
/// Score sort never floats phishing to the top of its own bucket.
nonisolated func calculateWinnowScore(email: WinnowEmail, sig: EmailSignals, profile: UserProfile) -> Int {
    var score = 50

    score += senderRankBonus(sender: email.sender, profile: profile)

    score -= Int(profile.trashBias(for: email.sender) * 40)
    score -= Int(sig.spamLikelihood * 40)

    if email.starred { score += 15 }

    let text = "\(email.subject) \(email.body)"
    for (intentRegex, weight) in intentRegexes {
        if matches(intentRegex, in: text) { score += weight }
    }

    return max(0, min(100, score))
}

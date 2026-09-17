import Foundation

/// Classifies one email into cached `EmailSignals`.
///
/// Every signal is keyword/regex based (tables in `Heuristics.swift`); the only
/// adaptive input is `weights`, supplied by `WinnowStore` from the user-tuned
/// `LearningModel`. Pure function: same inputs always yield the same signals.
///
/// - Parameters:
///   - email: Message to classify.
///   - profile: Per-sender engagement stats from `buildUserProfile`.
///   - weights: Signal weights; defaults reproduce the hand-tuned constants.
/// - Returns: Signals consumed by filtering, badges, and the learning loop.
nonisolated func classifyEmail(
    email: WinnowEmail,
    profile: UserProfile,
    weights: SignalWeights = .standard
) -> EmailSignals {
    let text = contentBag(email)
    let bias = profile.trashBias(for: email.sender)
    let actionText = "\(email.subject) \(email.body)"

    let security = securityKeywords.any(text)
    let newsletterHits = newsletterKeywords.count(text)
    let newsletter = email.type == "newsletter" || newsletterHits >= 2
    let securitySignal = security || email.type == "security"

    let promotional = (email.type == "promotional" || matches(promoRegex, in: text)) && !securitySignal

    let urgentText = email.urgent || urgentKeywords.any(text)

    let needsAction = needsActionRegexes.contains { matches($0, in: actionText) }
        || (matches(replyRequestRegex, in: actionText) && !newsletter && !promotional)
    // Transactional mail (invoices, receipts, billing) — but security notices and
    // obvious promos ("20% off your next order") are not real receipts.
    let finance = (financeKeywords.any(text) || matches(financeRegex, in: text))
        && !securitySignal && !promotional
    // Codes, deliveries, travel, and events are separate semantic buckets; all
    // stop at security, promo, and bulk mail so a bucket never swallows the
    // mail the other buckets are for.
    let codes = codesKeywords.any(text) && !securitySignal
    let shipping = shippingKeywords.any(text) && !securitySignal && !promotional
    let travel = travelKeywords.any(text) && !securitySignal && !promotional && !newsletter
    let events = eventsKeywords.any(text) && !securitySignal && !promotional && !newsletter
    let social = (socialKeywords.any(text) || matchesSocialDomain(email))
        && !securitySignal && !newsletter && !promotional
    let longRead = bodyWordCount(email) >= 250
    let phishingSignal = matches(phishingRegex, in: actionText)

    // Empty subjects/bodies are a strong spam tell; weight them heavily.
    var spamLikelihood = 0.0
    let subjectEmpty = email.subject.trimmingCharacters(in: .whitespaces).isEmpty
    let bodyEmpty = email.body.trimmingCharacters(in: .whitespaces).isEmpty
    if subjectEmpty && bodyEmpty {
        spamLikelihood += 0.55
    } else if subjectEmpty {
        spamLikelihood += 0.2
    }

    let sender = email.sender.trimmingCharacters(in: .whitespaces)
    if !sender.isEmpty,
       sender.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) != nil {
        let lower = sender.lowercased()
        if lower.hasPrefix("noreply"), newsletter || promotional {
            spamLikelihood += 0.05
        }
        if lower.hasPrefix("marketing") || lower.hasPrefix("digest") {
            spamLikelihood += 0.05
        }
        let domain = sender.split(separator: "@").last.map(String.init) ?? ""
        if domain.lowercased().hasSuffix("example.com") { spamLikelihood += 0.18 }
        if domain.contains(where: { $0.isNumber }) { spamLikelihood += 0.1 }
    }

    if phishingSignal {
        spamLikelihood += 0.3
    } else if matches(clickHereRegex, in: actionText) {
        spamLikelihood += 0.08
    }

    let spamHits = spamKeywords.count(text)
    if spamHits > 0 {
        spamLikelihood += min(0.35, 0.15 + Double(spamHits - 1) * 0.08)
    }

    // "Shouty" all-caps subjects with multiple exclamation marks read as spam.
    // Counted manually over UTF-8 bytes — two regex passes over the subject per
    // email added up. ASCII only: accented caps are rare in spam subjects.
    var upperCount = 0
    var alphaCount = 0
    for byte in email.subject.utf8 {
        switch byte {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"): upperCount += 1; alphaCount += 1
        case UInt8(ascii: "a")...UInt8(ascii: "z"): alphaCount += 1
        default: break
        }
    }
    let shouty = alphaCount > 5 && (Double(upperCount) / Double(alphaCount) > 0.55) && email.subject.contains("!!")
    if shouty { spamLikelihood += 0.12 }

    let boundedBias = bias
    spamLikelihood += boundedBias * 0.22
    if newsletter && promotional { spamLikelihood += 0.08 }
    spamLikelihood = min(1, spamLikelihood)

    var importanceScore = 50
    if email.starred { importanceScore += Int(weights.starBoost) }
    importanceScore += senderRankBonus(sender: email.sender, profile: profile, topBoost: Int(weights.topSenderBoost))

    if securitySignal { importanceScore += Int(weights.security) }
    if urgentText { importanceScore += Int(weights.urgency) }
    if needsAction { importanceScore += Int(weights.actionNeeded) }
    if finance { importanceScore += Int(weights.finance) }
    if newsletter { importanceScore -= Int(weights.newsletterPenalty) }
    if promotional { importanceScore -= Int(weights.promoPenalty) }

    importanceScore -= Int(spamLikelihood * weights.spamSensitivity)
    importanceScore -= Int(boundedBias * 14)
    if profile.quietSenders.contains(email.sender) { importanceScore -= Int(weights.quietContactPenalty) }

    return EmailSignals(
        security: securitySignal,
        newsletter: newsletter,
        promotional: promotional,
        urgentText: urgentText,
        needsAction: needsAction,
        finance: finance,
        spamLikelihood: spamLikelihood,
        importanceScore: importanceScore,
        codes: codes,
        shipping: shipping,
        travel: travel,
        events: events,
        social: social,
        longRead: longRead
    )
}

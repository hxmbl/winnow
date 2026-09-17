import Foundation

/// Per-email classification produced by the rule engine.
struct EmailSignals {
    /// Spam likelihood at or above which a message is Unsafe: hidden from the
    /// default inbox, excluded from most positive buckets, flagged in UI.
    nonisolated static let unsafeThreshold = 0.4

    var security: Bool
    var newsletter: Bool
    var promotional: Bool
    var urgentText: Bool
    var needsAction: Bool
    /// Transactional mail: invoices, receipts, payment and billing notices.
    var finance: Bool
    /// One-time login / verification codes (OTP, 2FA) — distinct from `.security`.
    var codes: Bool
    /// Package tracking and delivery notifications.
    var shipping: Bool
    /// Flight, hotel, and itinerary correspondence.
    var travel: Bool
    /// Calendar invites, RSVPs, webinars, and meet-ups.
    var events: Bool
    /// Social-platform notifications (mentions, follows, friend requests).
    var social: Bool
    /// Substantive long-form mail, gated by body length.
    var longRead: Bool

    /// 0…1 confidence the message is junk. At or above `unsafeThreshold`
    /// the message is treated as unsafe (see above).
    var spamLikelihood: Double

    /// Weighted importance starting from a base of 50; intentionally unclamped.
    /// The Important bucket matches at `>= 56`.
    var importanceScore: Int

    nonisolated var isUnsafe: Bool { spamLikelihood >= Self.unsafeThreshold }

    nonisolated init(
        security: Bool,
        newsletter: Bool,
        promotional: Bool,
        urgentText: Bool,
        needsAction: Bool,
        finance: Bool,
        spamLikelihood: Double,
        importanceScore: Int,
        codes: Bool = false,
        shipping: Bool = false,
        travel: Bool = false,
        events: Bool = false,
        social: Bool = false,
        longRead: Bool = false
    ) {
        self.security = security
        self.newsletter = newsletter
        self.promotional = promotional
        self.urgentText = urgentText
        self.needsAction = needsAction
        self.finance = finance
        self.spamLikelihood = spamLikelihood
        self.importanceScore = importanceScore
        self.codes = codes
        self.shipping = shipping
        self.travel = travel
        self.events = events
        self.social = social
        self.longRead = longRead
    }

    /// All-clear classification used when a cached signal is missing — the
    /// same result a quiet, clean email would receive.
    nonisolated static let neutral = EmailSignals(
        security: false, newsletter: false, promotional: false, urgentText: false,
        needsAction: false, finance: false, spamLikelihood: 0, importanceScore: 50
    )
}

extension EmailSignals {
    /// Buckets this email belongs to (excluding the star, which comes from
    /// `email.starred`). Icons and palettes come from the bucket itself.
    var badgeFilters: [BuiltinSmartFilter] {
        var result: [BuiltinSmartFilter] = []
        if importanceScore >= 70 { result.append(.important) }
        if urgentText { result.append(.urgent) }
        if needsAction && !newsletter { result.append(.needsAction) }
        if security { result.append(.security) }
        if finance && !isUnsafe { result.append(.receipts) }
        if codes && !isUnsafe { result.append(.codes) }
        if shipping && !isUnsafe { result.append(.shipping) }
        if travel && !isUnsafe { result.append(.travel) }
        if events && !isUnsafe { result.append(.events) }
        if newsletter { result.append(.newsletters) }
        if promotional { result.append(.promotional) }
        if isUnsafe { result.append(.unsafe) }
        return result
    }

    /// Compact subset of `badgeFilters` shown in list rows so they stay
    /// uncluttered; the viewer shows the full set. Derived from `badgeFilters`
    /// rather than re-encoded, so thresholds can never drift between the two.
    var rowIndicators: [BuiltinSmartFilter] {
        let rowHidden: Set<BuiltinSmartFilter> = [
            .needsAction, .receipts, .codes, .shipping, .travel, .events,
        ]
        return badgeFilters.filter { !rowHidden.contains($0) }
    }
}

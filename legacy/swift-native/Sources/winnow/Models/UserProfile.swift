import Foundation

/// A lightweight "digital profile": per-sender engagement and discard frequency.
/// Derived from inbox + trash with simple rules, not machine learning.
struct UserProfile {
    /// Upper bound applied anywhere trash bias feeds classification or scoring,
    /// so one prolifically-discarded sender can never dominate the ranking.
    nonisolated static let maxTrashBias = 0.35

    var trashBiasBySender: [String: Double]
    /// Highest-engagement senders (weighted by volume and stars).
    var topSenders: [String]
    /// Rare senders still in the inbox — the "cold" side of the habit curve.
    var quietSenders: [String]
    /// Cold outreach: one inbox email, never trashed — someone you haven't
    /// engaged yet.
    var firstTimeSenders: [String]

    nonisolated init(
        trashBiasBySender: [String: Double],
        topSenders: [String],
        quietSenders: [String],
        firstTimeSenders: [String] = []
    ) {
        self.trashBiasBySender = trashBiasBySender
        self.topSenders = topSenders
        self.quietSenders = quietSenders
        self.firstTimeSenders = firstTimeSenders
    }

    /// The sender's trash bias, capped at `maxTrashBias`. Single source of
    /// truth for the cap — classifier, scorer, and standing all read this.
    nonisolated func trashBias(for sender: String) -> Double {
        min(trashBiasBySender[sender] ?? 0, Self.maxTrashBias)
    }

    /// Engagement tier matching `senderRankBonus`: 0 = rank #0 (full boost),
    /// 1 = ranks 1–2 (⅔), 2 = ranks 3–5 (⅓), 3 = unranked (0).
    nonisolated func tier(for sender: String) -> Int {
        guard let rank = topSenders.firstIndex(of: sender) else { return 3 }
        if rank == 0 { return 0 }
        if rank <= 2 { return 1 }
        if rank < 6 { return 2 }
        return 3
    }

    /// The profile inputs that feed classification for one sender. Mirrors the
    /// classifier's tiers exactly; derived from the same accessors above so the
    /// two can never drift apart.
    struct Standing: Equatable {
        var tier: Int
        var isQuiet: Bool
        var trashBias: Double
    }

    nonisolated func standing(for sender: String) -> Standing {
        Standing(
            tier: tier(for: sender),
            isQuiet: quietSenders.contains(sender),
            trashBias: trashBias(for: sender)
        )
    }
}

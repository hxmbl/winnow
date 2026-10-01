import Foundation

/// Builds the per-sender engagement profile from the inbox and trash.
///
/// - Parameters:
///   - inbox: Current inbox threads.
///   - trash: Trashed rows, used to compute each sender's discard bias.
/// - Returns: A `UserProfile` with trash bias, top senders, and quiet senders.
nonisolated func buildUserProfile(inbox: [WinnowEmail], trash: [TrashRow]) -> UserProfile {
    var inboxStats: [String: (count: Int, starred: Int)] = [:]
    for email in inbox {
        var current = inboxStats[email.sender] ?? (count: 0, starred: 0)
        current.count += 1
        if email.starred { current.starred += 1 }
        inboxStats[email.sender] = current
    }

    var trashStats: [String: Int] = [:]
    for row in trash {
        trashStats[row.sender] = (trashStats[row.sender] ?? 0) + 1
    }

    let senders = Set(inboxStats.keys).union(trashStats.keys)

    var trashBiasBySender: [String: Double] = [:]
    var engagement: [(sender: String, score: Double, inbox: Int)] = []

    for sender in senders {
        let inboxCount = inboxStats[sender]?.count ?? 0
        let starred = inboxStats[sender]?.starred ?? 0
        let trashed = trashStats[sender] ?? 0
        // Bias rises with how often a sender is discarded relative to received.
        trashBiasBySender[sender] = Double(trashed) / (Double(trashed + inboxCount) + 1)

        if inboxCount > 0 {
            // Engagement weights volume, stars (×2), and penalizes trashing.
            let score = Double(inboxCount) + Double(starred) * 2 - Double(trashed) * 0.35
            engagement.append((sender: sender, score: score, inbox: inboxCount))
        }
    }

    engagement.sort { $0.score > $1.score }
    let topSenders = engagement.prefix(6).map { $0.sender }

    // "Quiet" senders are the least frequent, but only those truly rare
    // (≤ 2 inbox emails) count as the cold tail of the habit curve.
    let byVolume = engagement.sorted { $0.inbox < $1.inbox }
    let quietCut = max(1, Int(ceil(Double(byVolume.count) / 3)))
    let quietSenders = byVolume.prefix(quietCut)
        .filter { $0.inbox <= 2 }
        .map { $0.sender }

    // First-time senders: exactly one inbox email and never discarded — cold
    // outreach rather than a sender you've simply gone quiet on.
    let firstTimeSenders = engagement
        .filter { $0.inbox == 1 && (trashStats[$0.sender] ?? 0) == 0 }
        .map { $0.sender }
        .sorted()

    return UserProfile(
        trashBiasBySender: trashBiasBySender,
        topSenders: topSenders,
        quietSenders: quietSenders,
        firstTimeSenders: firstTimeSenders
    )
}

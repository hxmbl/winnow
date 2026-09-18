import Foundation

/// Filters, searches, and sorts an already-classified inbox.
///
/// Search splits the query on whitespace; every token must appear somewhere in
/// sender + subject + body (AND semantics), case-insensitively. Pass
/// `searchBags` (per-email lowercased haystacks) to avoid rebuilding those
/// strings on every keystroke; missing ids fall back to computing on the fly.
/// Active filters combine with AND. With no filters, messages at or above the
/// Unsafe threshold are hidden so the inbox stays clean by default.
///
/// - Parameters:
///   - inbox: Messages to process.
///   - filters: Buckets/senders that must all match; empty means unfiltered.
///   - searchQuery: Free-text query; whitespace-only is ignored.
///   - sortBy: Result ordering.
///   - profile: Engagement stats (top/quiet senders, trash bias).
///   - signals: Precomputed classification keyed by email id.
///   - searchBags: Optional precomputed `wordBag` values keyed by email id.
/// - Returns: The visible emails in display order.
nonisolated func filterAndSortInbox(
    inbox: [WinnowEmail],
    filters: [FilterId],
    searchQuery: String,
    sortBy: SortBy,
    profile: UserProfile,
    signals: [Int: EmailSignals],
    searchBags: [Int: String] = [:]
) -> [WinnowEmail] {
    let query = searchQuery.trimmingCharacters(in: .whitespaces).lowercased()
    let tokens = query.split(whereSeparator: \.isWhitespace).map(String.init)

    var output = inbox
    if !tokens.isEmpty {
        output = output.filter { email in
            let bag = searchBags[email.id] ?? wordBag(email)
            return tokens.allSatisfy { bag.contains($0) }
        }
    }

    if !filters.isEmpty {
        // All active filters must match (AND) — picking several buckets narrows the list.
        output = output.filter { email in
            let sig = signals[email.id] ?? .neutral
            return filters.allSatisfy { matchesSmartFilter(filter: $0, email: email, sig: sig, profile: profile) }
        }
    } else {
        // No filter selected: hide the spam bucket so the inbox stays clean by default.
        output = output.filter { (signals[$0.id]?.spamLikelihood ?? 0) < EmailSignals.unsafeThreshold }
    }

    switch sortBy {
    case .date:
        output.sort { $0.receivedAt > $1.receivedAt }
    case .sender:
        output.sort { $0.sender.localizedStandardCompare($1.sender) == .orderedAscending }
    case .score:
        // Scores are only needed for this sort — skip the regex pass otherwise.
        // The recency window is the filtered set itself, so the new-incoming
        // bonus compares mail against the mail it actually ranks among.
        var scores: [Int: Int] = [:]
        scores.reserveCapacity(output.count)
        let recency = ScoreRecencyContext.window(of: output.map(\.receivedAt))
        for email in output {
            let sig = signals[email.id] ?? .neutral
            scores[email.id] = calculateWinnowScore(email: email, sig: sig, profile: profile, recency: recency)
        }
        output.sort { (scores[$0.id] ?? 0) > (scores[$1.id] ?? 0) }
    }

    return output
}

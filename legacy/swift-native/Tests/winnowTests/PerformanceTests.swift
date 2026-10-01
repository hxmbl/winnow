import Foundation
import Testing
@testable import winnow

/// Wall-clock guard rails. Ceilings are deliberately loose — they exist to
/// catch catastrophic regressions in the classification pipeline (the kind
/// that stall the main thread and spin the beach ball), not to benchmark.
/// Each measurement takes the fastest of three runs so a busy test machine
/// doesn't produce flaky failures.
@MainActor
struct PerformanceTests {

    private static let inbox = mockInbox
    private static let trash = mockTrash

    private func timed(iterations: Int = 3, _ body: () -> Void) -> TimeInterval {
        var best = TimeInterval.greatestFiniteMagnitude
        for _ in 0..<iterations {
            let start = Date()
            body()
            best = min(best, Date().timeIntervalSince(start))
        }
        return best
    }

    @Test func fullInboxClassificationStaysFast() {
        let elapsed = timed {
            let profile = buildUserProfile(inbox: Self.inbox, trash: Self.trash)
            for email in Self.inbox {
                _ = classifyEmail(email: email, profile: profile)
            }
        }

        // ~114 emails; precompiled matchers keep this in the low milliseconds.
        #expect(elapsed < 1.0)
    }

    @Test func filterAndSortSweepStaysFast() {
        let profile = buildUserProfile(inbox: Self.inbox, trash: Self.trash)
        var signals: [Int: EmailSignals] = [:]
        signals.reserveCapacity(Self.inbox.count)
        for email in Self.inbox {
            signals[email.id] = classifyEmail(email: email, profile: profile)
        }
        var bags: [Int: String] = [:]
        for email in Self.inbox { bags[email.id] = wordBag(email) }

        let elapsed = timed {
            _ = filterAndSortInbox(
                inbox: Self.inbox,
                filters: [],
                searchQuery: "winnow",
                sortBy: .score,
                profile: profile,
                signals: signals,
                searchBags: bags
            )
        }

        #expect(elapsed < 1.0)
    }
}

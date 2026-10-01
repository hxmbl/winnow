import Testing
@testable import winnow

@MainActor
struct PipelineTests {

    private func makeInbox() -> [WinnowEmail] {
        [
            Fixtures.email(id: 1, sender: "bob@x.co", receivedAt: 100, starred: true),
            Fixtures.email(id: 2, sender: "alice@x.co", receivedAt: 300, subject: "Invoice overdue", body: "See attachment."),
            Fixtures.email(id: 3, sender: "carol@x.co", receivedAt: 200, type: "promotional"),
            Fixtures.email(id: 4, sender: "dan@x.co", receivedAt: 400, body: "Could you review this?"),
            Fixtures.email(id: 5, sender: "erin@x.co", receivedAt: 50, starred: true)
        ]
    }

    private func makeSignals(for inbox: [WinnowEmail]) -> [Int: EmailSignals] {
        var signals: [Int: EmailSignals] = [:]
        for email in inbox {
            switch email.id {
            case 1: signals[1] = Fixtures.signals(importanceScore: 70)
            case 2: signals[2] = Fixtures.signals(spamLikelihood: 0.8)
            case 3: signals[3] = Fixtures.signals(newsletter: true, promotional: true)
            case 4: signals[4] = Fixtures.signals(needsAction: true, importanceScore: 65)
            default: signals[email.id] = Fixtures.signals(importanceScore: 30)
            }
        }
        return signals
    }

    private func run(_ inbox: [WinnowEmail], filters: [FilterId] = [], query: String = "") -> [Int] {
        run(inbox, filters: filters, query: query, sort: .date, profile: Fixtures.profile(), signals: nil)
    }

    private func run(
        _ inbox: [WinnowEmail],
        filters: [FilterId],
        query: String,
        sort: SortBy,
        profile: UserProfile,
        signals: [Int: EmailSignals]?
    ) -> [Int] {
        filterAndSortInbox(
            inbox: inbox,
            filters: filters,
            searchQuery: query,
            sortBy: sort,
            profile: profile,
            signals: signals ?? makeSignals(for: inbox)
        )
        .map(\.id)
    }

    // MARK: Default view

    @Test func defaultViewHidesUnsafeMailAndSortsByDate() {
        #expect(run(makeInbox()) == [4, 3, 1, 5])   // newest first, id 2 is unsafe
    }

    @Test func theUnsafeFilterShowsExactlyTheUnsafeBucket() {
        #expect(run(makeInbox(), filters: [.builtin(.unsafe)]) == [2])
    }

    @Test func activeFiltersCombineWithAndSemantics() {
        #expect(run(makeInbox(), filters: [.builtin(.starred)]) == [1, 5])
        #expect(run(makeInbox(), filters: [.builtin(.starred), .builtin(.important)]) == [1])
    }

    @Test func overlappingBucketsIntersectInsteadOfUnion() {
        #expect(run(makeInbox(), filters: [.builtin(.newsletters)]) == [3])
        #expect(run(makeInbox(), filters: [.builtin(.newsletters), .builtin(.promotional)]) == [3])
    }

    @Test func senderFiltersNarrowToExactlyOneSender() {
        #expect(run(makeInbox(), filters: [.sender("dan@x.co")]) == [4])
    }

    // MARK: Search

    @Test func searchIsCaseInsensitiveAcrossSenderSubjectAndBody() {
        #expect(run(makeInbox(), query: "review") == [4])
        #expect(run(makeInbox(), query: "BOB") == [1])
    }

    @Test func searchTrimsWhitespaceButStillHonorsTheDefaultSafetyNet() {
        #expect(run(makeInbox(), query: "  review  ") == [4])
        // Searching for an unsafe email does not resurface it without the Unsafe filter.
        #expect(run(makeInbox(), query: "ALICE") == [])
        #expect(run(makeInbox(), filters: [.builtin(.unsafe)], query: "ALICE") == [2])
    }

    @Test func queriesWithoutMatchesYieldAnEmptyList() {
        #expect(run(makeInbox(), query: "zzz") == [])
    }

    @Test func multiWordQueriesRequireEveryTokenToMatch() {
        // "review" alone hits id 4; adding a non-matching token narrows to nothing.
        #expect(run(makeInbox(), query: "could review") == [4])
        #expect(run(makeInbox(), query: "review lasagna") == [])
        // Tokens may span fields: sender + body words combine with AND.
        #expect(run(makeInbox(), query: "bob lunch") == [1])
    }

    @Test func precomputedSearchBagsMatchTheComputedOnes() {
        let inbox = makeInbox()
        var bags: [Int: String] = [:]
        for email in inbox { bags[email.id] = wordBag(email) }
        #expect(run(inbox, filters: [], query: "review", sort: .date, profile: Fixtures.profile(), signals: makeSignals(for: inbox)) ==
            filterAndSortInbox(
                inbox: inbox,
                filters: [],
                searchQuery: "review",
                sortBy: .date,
                profile: Fixtures.profile(),
                signals: makeSignals(for: inbox),
                searchBags: bags
            ).map(\.id)
        )
    }

    // MARK: Sorting

    @Test func senderSortIgnoresCase() {
        let inbox = [
            Fixtures.email(id: 1, sender: "zoe@x.co", receivedAt: 999),
            Fixtures.email(id: 2, sender: "alice@x.co", receivedAt: 888),
            Fixtures.email(id: 3, sender: "mike@x.co", receivedAt: 777)
        ]
        #expect(run(inbox, filters: [], query: "", sort: .sender, profile: Fixtures.profile(), signals: [:]) == [2, 3, 1])
    }

    @Test func scoreSortFollowsWinnowScoreRatherThanArrivalTime() {
        let inbox = [
            Fixtures.email(id: 1, sender: "bob@x.co", receivedAt: 200),
            Fixtures.email(id: 2, sender: "alice@x.co", receivedAt: 100, subject: "Invoice attached", body: "Your invoice is overdue."),
            Fixtures.email(id: 3, sender: "carol@x.co", receivedAt: 900, subject: "Flash sale", body: "Everything is 20% off.")
        ]
        #expect(run(inbox, filters: [], query: "", sort: .score, profile: Fixtures.profile(), signals: [:]) == [2, 1, 3])   // 68 / 50 / 45 (newest recency bonus) despite arrival order
    }

    // MARK: Filter rail ranking

    @Test func rankFiltersPinsPermanentBucketsFirstThenRanksByCount() {
        let inbox = makeInbox()
        let ranked = rankFilters(inbox: inbox, signals: makeSignals(for: inbox), profile: Fixtures.profile())

        // Pinned buckets lead, in their fixed order, even when empty.
        #expect(ranked.prefix(permanentFilterIds.count).map(\.id) == permanentFilterIds)
        // The rest surface by current match count (starred: 2, the rest tie at 1),
        // with the exclusive Unsafe safety-valve pinned last.
        #expect(Array(ranked.dropFirst(permanentFilterIds.count).map(\.id)) == [.starred, .needsAction, .newsletters, .promotional, .unsafe])
        // Empty buckets are hidden entirely.
        for empty in [BuiltinSmartFilter.codes, .travel, .events, .unread, .security] {
            #expect(!ranked.contains { $0.id == empty })
        }
        // No duplicates.
        #expect(Set(ranked.map(\.id)).count == ranked.count)
    }

    @Test func rankFiltersHidesEmptyBucketsEvenWithMailFlow() {
        let inbox = [
            Fixtures.email(id: 1, subject: "Security alert", body: "Reset your password now.")
        ]
        let ranked = rankFilters(inbox: inbox, signals: [:], profile: Fixtures.profile())
        let ids = ranked.map(\.id)

        #expect(ids == [.important, .shipping, .unsafe])
    }
}

import Testing
@testable import winnow

@MainActor
struct ModelTests {

    // MARK: displayName

    @Test func displayNamePrefersTheFriendlyName() {
        #expect(Fixtures.email(sender: "maya@winnow.app", name: "Maya Chen").displayName == "Maya Chen")
    }

    @Test func displayNameFallsBackToTheLocalPartOfTheAddress() {
        #expect(Fixtures.email(sender: "alex@winnow.app").displayName == "alex")
    }

    @Test func displayNameIgnoresEmptyFriendlyNames() {
        #expect(Fixtures.email(sender: "alex@winnow.app", name: "").displayName == "alex")
    }

    @Test func displayNameKeepsBareSendersWithoutAnAddress() {
        #expect(Fixtures.email(sender: "Figma").displayName == "Figma")
    }

    // MARK: FilterId identity

    @Test func builtinFilterIdsUseTheirRawValues() {
        #expect(FilterId.builtin(.starred).id == "starred")
        #expect(FilterId.builtin(.needsAction).id == "needs_action")
        #expect(FilterId.builtin(.lowPriority).id == "low_priority")
    }

    @Test func senderFilterIdsAreNamespacedSoTheyCannotCollideWithBuiltins() {
        #expect(FilterId.sender("starred").id == "sender:starred")
        #expect(FilterId.sender("starred").id != FilterId.builtin(.starred).id)
    }

    @Test func unsafeIsTheOnlyExclusiveBucket() {
        for filter in BuiltinSmartFilter.allCases {
            #expect(FilterId.builtin(filter).isUnsafe == (filter == .unsafe))
        }
    }

    // MARK: SortBy labels

    @Test func everySortOptionHasALabel() {
        #expect(SortBy.date.label == "Date")
        #expect(SortBy.sender.label == "Sender")
        #expect(SortBy.score.label == "Smart Score")
        #expect(SortBy.allCases.count == 3)
    }

    // MARK: Row indicators

    @Test func rowIndicatorsAreBadgeFiltersMinusViewerOnlyBuckets() {
        let sig = Fixtures.signals(
            security: true,
            newsletter: true,
            urgentText: true,
            needsAction: true,
            finance: true,
            importanceScore: 80
        )
        #expect(sig.badgeFilters == [.important, .urgent, .security, .receipts, .newsletters])
        #expect(sig.rowIndicators == [.important, .urgent, .security, .newsletters])

        let quiet = Fixtures.signals(needsAction: true, finance: true)
        #expect(quiet.badgeFilters.contains(.needsAction) && !quiet.rowIndicators.contains(.needsAction))
        #expect(quiet.badgeFilters.contains(.receipts) && !quiet.rowIndicators.contains(.receipts))
    }
}

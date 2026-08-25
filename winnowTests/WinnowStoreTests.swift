import Foundation
import SwiftUI
import Testing
@testable import winnow

/// Each suite instance runs against its own `UserDefaults` domain, so learning
/// state can never leak between tests.
@MainActor
final class WinnowStoreTests {

    private let suiteName: String
    private let defaults: UserDefaults

    init() {
        suiteName = "winnow.tests.store.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)!
    }

    deinit {
        UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
    }

    private func makeStore(inbox: [WinnowEmail]? = nil) -> WinnowStore {
        let store = WinnowStore(learning: LearningModel(defaults: defaults), defaults: defaults)
        // Tests never go live — even though the host app bundle now carries
        // real credentials, signIn() must stay in demo mode here.
        store.isLiveModeAvailable = { false }
        if let inbox { store.inbox = inbox }
        return store
    }

    /// Polls an async condition with a timeout so debounced work can be awaited
    /// without fixed sleeps.
    private func waitFor(
        _ description: String,
        timeoutNanos: UInt64 = 2_000_000_000,
        _ condition: () -> Bool
    ) async {
        let start = Date()
        while !condition() {
            if Date().timeIntervalSince(start) > Double(timeoutNanos) / 1_000_000_000 {
                Issue.record("Timed out waiting for \(description)")
                return
            }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    // MARK: Filter toggling

    @Test func filtersCombineUntilUnsafeReplacesEverything() {
        let store = makeStore()

        store.toggleFilter(.builtin(.starred))
        store.toggleFilter(.builtin(.receipts))
        #expect(store.activeFilters == [.builtin(.starred), .builtin(.receipts)])

        store.toggleFilter(.builtin(.unsafe))
        #expect(store.activeFilters == [.builtin(.unsafe)])

        store.toggleFilter(.builtin(.unsafe))
        #expect(store.activeFilters.isEmpty)
    }

    @Test func togglingTheSameFilterTwiceRemovesIt() {
        let store = makeStore()
        store.toggleFilter(.builtin(.important))
        store.toggleFilter(.builtin(.important))
        #expect(store.activeFilters.isEmpty)
    }

    @Test func clearAllFiltersEmptiesTheSelection() {
        let store = makeStore()
        store.toggleFilter(.builtin(.starred))
        store.toggleFilter(.sender("mom@example.com"))

        store.clearAllFilters()

        #expect(store.activeFilters.isEmpty)
    }

    @Test func showUnsafeJumpsToTheExclusiveBucket() {
        let store = makeStore()
        store.showUnsafe()
        #expect(store.activeFilters == [.builtin(.unsafe)])
    }

    // MARK: Derived titles & rows

    @Test func listTitleTracksTheSelection() {
        let store = makeStore()
        #expect(store.listTitle == "Inbox")

        store.toggleFilter(.builtin(.important))
        #expect(store.listTitle == "Important")

        store.toggleFilter(.builtin(.urgent))
        #expect(store.listTitle == "Filtered")

        store.clearAllFilters()
        store.toggleFilter(.sender("mom@example.com"))
        #expect(store.listTitle == "From mom@example.com")
    }

    @Test func searchNarrowsRowsAndIgnoresWhitespaceOnlyChanges() {
        let inbox = [
            Fixtures.email(id: 1, body: "I'm making your favorite lasagna."),
            Fixtures.email(id: 2, subject: "Invoice attached"),
            Fixtures.email(id: 3, sender: "dan@x.co", body: "Could you review this?"),
        ]
        let store = makeStore(inbox: inbox)

        store.searchQuery = "  lasagna  "
        #expect(store.filteredEmails.map(\.id) == [1])

        store.searchQuery = ""
        #expect(store.filteredEmails.count == 3)

        store.searchQuery = "review"
        #expect(store.filteredEmails.map(\.id) == [3])

        store.searchQuery = "zzz"
        #expect(store.filteredEmails.isEmpty)
    }

    @Test func filteredEmailsCarryTheirCachedSignals() {
        let store = makeStore()

        for row in store.filteredEmails {
            #expect(row.id == row.email.id)
            #expect(row.sig.importanceScore == store.emailSignals[row.id]?.importanceScore)
        }
    }

    // MARK: Starring → learning

    @Test func starringFlipsTheThreadAndFeedsTheLearner() {
        let store = makeStore(inbox: [Fixtures.email(id: 7, body: "Flash sale! Everything is 20% off today.")])

        store.toggleStar(7)
        #expect(store.inbox[0].starred)
        #expect(store.learning.events.count == 1)
        #expect(store.learning.events[0].action == .starred)
        #expect(store.learning.weight(.promoPenalty) < SignalKey.promoPenalty.defaultValue)

        store.toggleStar(7)
        #expect(!store.inbox[0].starred)
        #expect(store.learning.events.count == 2)
        #expect(store.learning.events[1].action == .unstarred)
        #expect(store.learning.weight(.promoPenalty) == SignalKey.promoPenalty.defaultValue)
    }

    @Test func unknownEmailsAreIgnoredByToggleStar() {
        let store = makeStore()
        store.toggleStar(99_999)
        #expect(store.learning.events.isEmpty)
    }

    // MARK: Debounced weights sweep

    @Test func weightChangesReclassifyAfterTheDebounceWindow() async {
        // A one-email inbox makes its only sender both top (rank 0 → +18) and
        // quiet (−6), so the security email scores 50 + 18 + 16 − 6 = 78.
        let store = makeStore(inbox: [Fixtures.email(id: 5, subject: "Security alert", body: "Unusual activity.")])
        #expect(store.emailSignals[5]?.importanceScore == 78)

        store.learning.setWeight(.security, 30)
        await waitFor("sweep to apply the new security weight") {
            store.emailSignals[5]?.importanceScore == 92   // 50 + 18 + 30 − 6
        }
    }

    // MARK: Reader-card selection

    @Test func selectionResolvesAgainstTheFullInboxEvenWhenFilteredOut() {
        let inbox = [
            Fixtures.email(id: 1, starred: true),
            Fixtures.email(id: 2),
        ]
        let store = makeStore(inbox: inbox)

        store.openEmail(2)
        #expect(store.selectedEmail?.id == 2)

        // The Starred filter hides row 2's row, but its open card must survive.
        store.activeFilters = [.builtin(.starred)]
        #expect(store.filteredEmails.map(\.id) == [1])
        #expect(store.selectedEmail?.id == 2)

        store.dismissEmail()
        #expect(store.selectedEmail == nil)
    }

    @Test func selectionSurvivesUnknownIdsGracefully() {
        let store = makeStore()
        store.openEmail(424_242)
        #expect(store.selectedEmail == nil)
        store.dismissEmail()
        #expect(store.selectedEmailID == nil)
    }

    // MARK: Ranked rail

    @Test func railItemsCoverEveryBuiltinAndRefreshWithSignals() {
        let store = makeStore()
        let ids = store.railItems.map(\.filter.id)
        #expect(Set(ids) == Set(builtinFilters.map(\.id)))
        #if DEBUG
        #expect(store.railItems.count == builtinFilters.count * 3)
        #else
        #expect(store.railItems.count == builtinFilters.count)
        #endif
    }

    // MARK: Keyboard navigation & triage

    @Test func selectionMovesClampsAndOpensAlong() {
        let store = makeStore(inbox: [
            Fixtures.email(id: 1),
            Fixtures.email(id: 2),
            Fixtures.email(id: 3),
        ])

        store.moveSelection(1)
        #expect(store.selectedRowIndex == 0)
        #expect(store.selectedEmailID == nil)          // list mode: cursor only

        store.moveSelection(1)
        store.moveSelection(1)
        #expect(store.selectedRowIndex == 2)
        store.moveSelection(1)                          // clamp at bottom
        #expect(store.selectedRowIndex == 2)
        store.moveSelection(-10)                        // clamp at top
        #expect(store.selectedRowIndex == 0)

        store.openSelected()
        #expect(store.selectedEmailID == 1)

        // Viewer open: j drags the card to the next message.
        store.moveSelection(1)
        #expect(store.selectedEmailID == 2)
    }

    @Test func clickingARowMovesTheCursorWithIt() {
        let store = makeStore(inbox: [
            Fixtures.email(id: 1),
            Fixtures.email(id: 2),
        ])
        store.openEmail(2)
        #expect(store.selectedRowIndex == 1)
    }

    @Test func archiveRemovesRowAndAdvancesTriage() {
        let inbox = (1...4).map { Fixtures.email(id: $0) }
        let store = makeStore(inbox: inbox)
        store.openEmail(2)   // cursor on index 1, card open

        store.archiveEmail(2)

        #expect(store.inbox.map(\.id) == [1, 3, 4])
        #expect(store.filteredEmails.map(\.email.id) == [1, 3, 4])
        // Triage: the card advanced to what is now at the same position.
        #expect(store.selectedEmailID == 3)
        #expect(store.selectedRowIndex == 1)
    }

    @Test func archivingTheLastRowClosesTheCard() {
        let inbox = (1...2).map { Fixtures.email(id: $0) }
        let store = makeStore(inbox: inbox)
        store.openEmail(2)

        store.archiveEmail(2)

        #expect(store.inbox.map(\.id) == [1])
        #expect(store.selectedEmailID == 1)             // advanced to the only row left
        store.archiveEmail(1)
        #expect(store.filteredEmails.isEmpty)
        #expect(store.selectedEmailID == nil)
        #expect(store.selectedRowIndex == nil)
    }

    @Test func trashRemovesRowAndFeedsTheTrashBias() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, sender: "spam@x.co"), Fixtures.email(id: 2)])
        let trashBefore = store.trash.count

        store.moveSelection(1)   // cursor onto row 0
        store.trashEmail(1)

        #expect(!store.inbox.contains { $0.id == 1 })
        #expect(store.trash.count == trashBefore + 1)
        #expect(store.trash.last?.sender == "spam@x.co")
        #expect(store.selectedRowIndex == 0)
        #expect(store.filteredEmails.first?.email.id == 2)
    }

    @Test func filterDigitsRouteThroughTheRail() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, starred: true)])
        store.apply(.toggleFilter(railIndex: 5))   // "Starred" sits at rail index 5
        #expect(store.activeFilters == [.builtin(.starred)])
        store.apply(.toggleFilter(railIndex: 5))
        #expect(store.activeFilters.isEmpty)
        store.apply(.toggleFilter(railIndex: 999)) // out of range: no-op
        #expect(store.activeFilters.isEmpty)
    }

    // MARK: Session lifecycle

    @Test func signInAuthenticatesAndSignOutRestoresFactoryState() async {
        let store = makeStore()
        await store.signIn()
        #expect(store.authed)

        store.inbox = [Fixtures.email(id: 555, sender: "mutated@x.co")]
        store.trash = [TrashRow(sender: "mutated@x.co")]
        store.toggleFilter(.builtin(.unsafe))
        store.searchQuery = "mutated"
        store.openEmail(555)

        store.signOut()

        #expect(!store.authed)
        #expect(store.inbox == mockInbox)
        #expect(store.trash.map(\.sender) == mockTrash.map(\.sender))
        #expect(store.activeFilters.isEmpty)
        #expect(store.searchQuery.isEmpty)
        #expect(store.selectedEmail == nil)
    }

    @Test func authStatePersistsAcrossStoresInTheSameDomain() async {
        let first = makeStore()
        #expect(!first.authed)
        await first.signIn()

        let second = makeStore()
        #expect(second.authed)

        second.signOut()
        #expect(!makeStore().authed)
    }

    @Test func appearanceMapsOntoTheColorScheme() {
        let store = makeStore()
        #expect(store.appearance == .system)
        #expect(store.chosenScheme == nil)

        store.appearance = .dark
        #expect(store.chosenScheme == .dark)
        #expect(store.appearance == .dark)

        store.appearance = .light
        #expect(store.chosenScheme == .light)

        store.appearance = .system
        #expect(store.chosenScheme == nil)
    }

    @Test func refreshSettlesItsLoadingFlag() async {
        let store = makeStore()
        await store.refresh()
        #expect(!store.loading)
    }

    // MARK: Mock fixtures sanity

    @Test func mockDataPresentsAHealthyDefaultInbox() {
        let store = makeStore()

        #expect(!store.filteredEmails.isEmpty)
        #expect(Set(store.filteredEmails.map(\.id)).count == store.filteredEmails.count)
        #expect(store.listTitle == "Inbox")
    }
}

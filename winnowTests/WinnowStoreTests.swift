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
        // The sweep is debounced; under full-suite parallel load the main-actor
        // task can be starved well past the default 2s window, so allow more
        // time here — the assertion still verifies the sweep actually applies.
        await waitFor("sweep to apply the new security weight", timeoutNanos: 10_000_000_000) {
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

    @Test func railItemsOnlySurfaceBucketsWithMailPlusThePinnedOnes() {
        let store = makeStore()
        let ids = store.railItems.map(\.filter.id)

        // No duplicates; strictly a subset of the catalog.
        #expect(Set(ids).count == ids.count)
        #expect(Set(ids).isSubset(of: Set(builtinFilters.map(\.id))))
        // The always-watch buckets and the exclusive safety valve stay regardless of counts.
        for pinned in permanentFilterIds + [.unsafe] {
            #expect(ids.contains(pinned))
        }
    }

    @Test func emptyBucketsDisappearFromTheRail() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, starred: true)])

        let ids = store.railItems.map(\.filter.id)
        #expect(ids.first == .important)
        #expect(ids.contains(.shipping))
        #expect(ids.contains(.starred))
        #expect(ids.last == .unsafe)
        // Buckets with no mail this period vanish entirely.
        for hidden in [BuiltinSmartFilter.newsletters, .codes, .travel, .events, .attachments, .unread] {
            #expect(!ids.contains(hidden))
        }
    }

    // MARK: STO-139 — active filters lead the rail

    @Test func activeFiltersJumpAheadOfRankedBucketsInActivationOrder() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, starred: true)])
        // Receipts and Events hold no mail in this inbox: activating them must
        // still surface them — right after the permanent pins, in activation
        // order — while the safety valve stays pinned last. Ranked buckets
        // that do hold mail (Starred) slot in behind the active block.
        store.toggleFilter(.builtin(.receipts))
        store.toggleFilter(.builtin(.events))

        let ids = store.railItems.map(\.filter.id)
        #expect(ids.prefix(4) == [.important, .shipping, .receipts, .events])
        #expect(ids.contains(.starred))
        #expect(ids.last == .unsafe)
    }

    @Test func deactivatingAnEmptyActiveBucketRemovesItFromTheRail() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, starred: true)])
        store.toggleFilter(.builtin(.receipts))
        #expect(store.railItems.contains { $0.filter.id == .receipts })

        store.toggleFilter(.builtin(.receipts))
        #expect(!store.railItems.contains { $0.filter.id == .receipts })
        #expect(store.activeFilters.isEmpty)
    }

    @Test func activeBuiltinsNeverDuplicateOnTheRail() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, starred: true)])
        // Starred already ranks (it has mail); activating it must not add a
        // second pill.
        store.toggleFilter(.builtin(.starred))

        let ids = store.railItems.map(\.filter.id)
        #expect(Set(ids).count == ids.count)
        #expect(ids.filter { $0 == .starred }.count == 1)
        #expect(store.activeFilters == [.builtin(.starred)])
    }

    @Test func keyboardFocusFollowsTheActivatedPillToTheFront() {
        let store = makeStore(inbox: [Fixtures.email(id: 1)])
        store.toggleFilter(.builtin(.receipts))   // empty bucket, activated from the catalog

        guard let receiptsIndex = store.railItems.firstIndex(where: { $0.filter.id == .receipts }) else {
            Issue.record("Active receipts bucket missing from the rail")
            return
        }
        #expect(receiptsIndex == 2)   // right after the two permanent buckets
        #expect(store.focusedRailIndex == receiptsIndex)
    }

    @Test func unsafeStaysPinnedLastEvenWhenActive() {
        let store = makeStore()
        store.showUnsafe()
        #expect(store.activeFilters == [.builtin(.unsafe)])
        let ids = store.railItems.map(\.filter.id)
        let unsafeIndex = store.railItems.firstIndex { $0.filter.id == .unsafe }
        #expect(unsafeIndex == ids.count - 1)
    }

    // MARK: STO-138 — removed smart filters

    @Test func dismissingAFilterDeactivatesItAndRemovesItsPill() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, starred: true)])
        store.toggleFilter(.builtin(.receipts))
        #expect(store.activeFilters == [.builtin(.receipts)])

        store.dismissFilter(.receipts)

        #expect(store.activeFilters.isEmpty)
        #expect(store.isFilterRemoved(.receipts))
        #expect(!store.railItems.contains { $0.filter.id == .receipts })
    }

    @Test func dismissingTheUnsafeSafetyValveIsRefused() {
        let store = makeStore()
        store.dismissFilter(.unsafe)
        #expect(!store.isFilterRemoved(.unsafe))
        #expect(store.railItems.contains { $0.filter.id == .unsafe })
    }

    @Test func silencedBucketsStayOffTheRailAndCannotBeReToggled() {
        let store = makeStore(inbox: [Fixtures.email(id: 1)])
        store.dismissFilter(.promotional)
        store.toggleFilter(.builtin(.promotional))
        #expect(store.activeFilters.isEmpty)
        #expect(!store.railItems.contains { $0.filter.id == .promotional })
    }

    @Test func dismissingAFilterHidesItsMailFromTheDefaultInboxUntilRestored() {
        let newsletter = Fixtures.email(id: 1, body: "You can unsubscribe from this weekly digest anytime.")
        let work = Fixtures.email(id: 2, body: "Could you review the design doc today?")
        let store = makeStore(inbox: [newsletter, work])

        func visibleIDs() -> Set<Int> { Set(store.filteredEmails.map(\.id)) }
        #expect(visibleIDs() == [1, 2])

        store.dismissFilter(.newsletters)
        #expect(visibleIDs() == [2])

        store.restoreFilter(.newsletters)
        #expect(visibleIDs() == [1, 2])
    }

    @Test func anActivatedFilterOverridesASilencedBucket() {
        let newsletter = Fixtures.email(id: 1, body: "You can unsubscribe from this weekly digest anytime.", starred: true)
        let work = Fixtures.email(id: 2, body: "Could you review the design doc today?", starred: true)
        let store = makeStore(inbox: [newsletter, work])

        store.dismissFilter(.newsletters)
        #expect(Set(store.filteredEmails.map(\.id)) == [2])

        // An explicit selection wins over the mute — the user asked to see mail.
        store.toggleFilter(.builtin(.starred))
        #expect(Set(store.filteredEmails.map(\.id)) == [1, 2])
    }

    @Test func removedFiltersSurviveRecreatingTheStore() {
        let store = makeStore()
        store.dismissFilter(.newsletters)
        store.dismissFilter(.promotional)

        let reloaded = makeStore()
        #expect(reloaded.isFilterRemoved(.newsletters))
        #expect(reloaded.isFilterRemoved(.promotional))
        #expect(!reloaded.railItems.contains { $0.filter.id == .newsletters })
        #expect(!reloaded.railItems.contains { $0.filter.id == .promotional })
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

    @Test func trashMovesTheRowToTrashAndFeedsTheBias() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, sender: "spam@x.co"), Fixtures.email(id: 2)])
        let trashBefore = store.trash.count

        store.moveSelection(1)   // cursor onto row 0
        store.trashEmail(1)

        #expect(!store.inbox.contains { $0.id == 1 })
        #expect(store.trashed.map(\.id) == [1])
        #expect(store.trash.count == trashBefore + 1)
        #expect(store.trash.last?.sender == "spam@x.co")
        #expect(store.selectedRowIndex == 0)
        #expect(store.filteredEmails.first?.email.id == 2)
    }

    @Test func archiveMovesTheRowToArchiveAndRestoreBringsItBack() {
        let store = makeStore(inbox: [Fixtures.email(id: 1), Fixtures.email(id: 2)])

        store.archiveEmail(2)
        #expect(store.inbox.map(\.id) == [1])
        #expect(store.archived.map(\.id) == [2])

        store.unarchiveEmail(2)
        #expect(store.inbox.map(\.id).sorted() == [1, 2])
        #expect(store.archived.isEmpty)

        store.trashEmail(1)
        store.restoreEmail(1)
        #expect(store.inbox.contains { $0.id == 1 })
        #expect(store.trashed.isEmpty)
    }

    @Test func filterDigitsRouteThroughTheRail() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, starred: true)])
        guard let starredIndex = store.railItems.firstIndex(where: { $0.filter.id == .starred }) else {
            Issue.record("Starred is missing from the ranked rail")
            return
        }
        store.apply(.toggleFilter(railIndex: starredIndex))
        #expect(store.activeFilters == [.builtin(.starred)])
        #expect(store.focusedRailIndex == starredIndex)
        store.apply(.toggleFilter(railIndex: starredIndex))
        #expect(store.activeFilters.isEmpty)
        store.apply(.toggleFilter(railIndex: 999)) // out of range: no-op
        #expect(store.activeFilters.isEmpty)
    }

    // MARK: STO-137 — reader scroll state

    @Test func scrollReaderStepsAccumulateAndResetPerConversation() {
        let store = makeStore(inbox: [Fixtures.email(id: 1), Fixtures.email(id: 2)])
        #expect(store.viewerScrollStep == 0)

        store.apply(.scrollReader(1))
        store.apply(.scrollReader(1))
        store.apply(.scrollReader(-1))
        #expect(store.viewerScrollStep == 1)

        store.openEmail(1)
        #expect(store.viewerScrollStep == 0)   // a new conversation starts at the top
        store.apply(.scrollReader(1))
        store.dismissEmail()
        #expect(store.viewerScrollStep == 0)   // closing the reader resets the counter
    }

    // MARK: Session lifecycle

    @Test func signInAuthenticatesAndSignOutRestoresFactoryState() async {
        let store = makeStore()
        await store.signIn()
        #expect(store.authed)

        // Mutate every piece of session state, including the pieces earlier
        // regressions leaked through sign-out (T5).
        store.inbox = [Fixtures.email(id: 555, sender: "mutated@x.co")]
        store.trash = [TrashRow(sender: "mutated@x.co")]
        store.toggleFilter(.builtin(.unsafe))
        store.searchQuery = "mutated"
        store.openEmail(555)
        store.moveSelection(2)
        store.showShortcutOverlay = true
        defaults.set("999", forKey: GmailSyncEngine.historyIDKey)

        store.signOut()

        #expect(!store.authed)
        #expect(store.inbox == mockInbox)
        #expect(store.trash.map(\.sender) == mockTrash.map(\.sender))
        #expect(store.activeFilters.isEmpty)
        #expect(store.searchQuery.isEmpty)
        #expect(store.selectedEmail == nil)
        #expect(!store.showShortcutOverlay)          // H2: no stuck cheat sheet on the login screen
        #expect(store.selectedRowIndex == nil)
        #expect(store.syncError == nil)
        #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == nil)   // M5: account-scoped cursor
    }

    @Test func failedServerRemovalRollsBackInsteadOfLosingMail() async throws {
        // H3: an optimistic archive whose server call fails must restore the
        // row — not leave it invisible until a manual full sync.
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.store.rollback.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }

            StubURLProtocol.route { _ in (503, Data("backend down".utf8)) }

            let manager = TokenManager(store: InMemoryTokenStore(), credentialsProvider: {
                try GmailCredentials(plistData: try! PropertyListSerialization.data(
                    fromPropertyList: ["ClientID": "test-client.apps.googleusercontent.com"],
                    format: .xml, options: 0
                ))
            }, session: URLSession(configuration: StubURLProtocol.config))
            manager.adopt(TokenSet(
                accessToken: "t",
                refreshToken: "r",
                expiresAt: Date().addingTimeInterval(3600),
                scope: GmailCredentials.scope
            ))
            let client = GmailClient(tokenManager: manager, session: URLSession(configuration: StubURLProtocol.config))
            let cache = try EmailCacheStore(inMemory: true)
            try cache.upsert(email: Fixtures.email(id: 1), gmailId: "g1", threadId: "t")

            let store = WinnowStore(learning: LearningModel(defaults: defaults), defaults: defaults)
            store.injectLiveBackendForTesting(.init(client: client, sync: GmailSyncEngine(
                client: client,
                cache: cache,
                defaults: defaults
            ), cache: cache, tokens: manager))
            store.inbox = [Fixtures.email(id: 1)]

            store.archiveEmail(1)

            // The removal was optimistic: gone now, back once the failure lands.
            #expect(store.inbox.isEmpty)
            await waitFor("the rollback to restore the row") { !store.inbox.isEmpty }

            #expect(store.inbox.map(\.id) == [1])
            #expect(cache.count == 1)
            #expect(store.syncError != nil)
        }
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

    @Test(arguments: [true, false])
    func notificationOptInRequestsPermissionAndSurfacesDenial(granted: Bool) async {
        let store = makeStore()
        var calls = 0
        store.requestNotificationAuthorization = {
            calls += 1
            return granted
        }
        store.notificationsEnabled = true
        await waitFor("notification authorization") { calls == 1 }
        #expect(defaults.bool(forKey: WinnowStore.notificationsEnabledKey))
        #expect((store.notificationError == nil) == granted)
        store.notificationsEnabled = false
        #expect(store.notificationError == nil)
        #expect(!defaults.bool(forKey: WinnowStore.notificationsEnabledKey))
    }

    @Test func notificationOptOutIgnoresPendingPermissionResult() async {
        let store = makeStore()
        var continuation: CheckedContinuation<Bool, Never>?
        store.requestNotificationAuthorization = {
            await withCheckedContinuation { continuation = $0 }
        }
        store.notificationsEnabled = true
        await waitFor("permission request") { continuation != nil }
        store.notificationsEnabled = false
        continuation?.resume(returning: false)
        await Task.yield()
        #expect(!store.notificationsEnabled)
        #expect(store.notificationError == nil)
    }

    @Test func notificationAuthorizationFailureIsVisible() async {
        let store = makeStore()
        store.requestNotificationAuthorization = { throw URLError(.notConnectedToInternet) }
        store.notificationsEnabled = true
        await waitFor("notification error") { store.notificationError != nil }
        #expect(store.notificationError?.contains("Couldn't enable notifications") == true)
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

    // MARK: Mailbox views

    @Test func mailboxSwitchSwapsTheListAndClearsSelection() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, sender: "a@x.co"), Fixtures.email(id: 2, sender: "b@x.co")])
        store.archived = [Fixtures.email(id: 9, sender: "old@x.co")]
        store.trashed = [Fixtures.email(id: 42, sender: "gone@x.co")]

        store.mailbox = .archive
        #expect(store.filteredEmails.map(\.email.id) == [9])
        #expect(store.listTitle == "Archive")

        store.mailbox = .trash
        #expect(store.filteredEmails.map(\.email.id) == [42])
        #expect(store.listTitle == "Trash")
    }

    // MARK: Spam mailbox

    @Test func spamMailboxListsItsOwnRowsAndUnspamReturnsThemToTheInbox() {
        let store = makeStore(inbox: [Fixtures.email(id: 2, sender: "b@x.co")])
        store.spam = [Fixtures.email(id: 7, sender: "scam@x.co")]

        store.mailbox = .spam
        #expect(store.filteredEmails.map(\.email.id) == [7])
        #expect(store.listTitle == "Spam")

        // `e` inside Spam rescues the row (removes SPAM, adds INBOX).
        store.moveSelection(0)
        store.apply(.archive)
        #expect(store.spam.isEmpty)
        #expect(store.inbox.map(\.id).sorted() == [2, 7])
        #expect(store.emails(for: .spam).isEmpty)
    }

    @Test func spamEmailResolvesInItsMailboxAndAdoptSurfacesIt() {
        let store = makeStore(inbox: [Fixtures.email(id: 2, sender: "b@x.co")])
        store.spam = [Fixtures.email(id: 7, sender: "scam@x.co")]
        store.mailbox = .spam
        store.openEmail(7)
        #expect(store.selectedEmail?.id == 7)
        #expect(store.selectedEmail?.sender == "scam@x.co")
        store.dismissEmail()

        // adopt() is the incremental-sync landing pad — spam must survive it.
        let snapshot = GmailMailboxSnapshot(
            inbox: [Fixtures.email(id: 2, sender: "b@x.co")],
            archive: [],
            trash: [],
            spam: [Fixtures.email(id: 7, sender: "scam@x.co"), Fixtures.email(id: 8, sender: "nigerian@x.co")]
        )
        store.adopt(snapshot)
        #expect(store.spam.map(\.id).sorted() == [7, 8])
        #expect(store.inbox.map(\.id) == [2])
    }

    // MARK: Compact navigation palette (STO-118)

    @Test func navigationTogglesAndReArmsToTheCurrentMailbox() {
        let store = makeStore(inbox: [Fixtures.email(id: 1)])
        store.mailbox = .trash

        #expect(!store.navigationVisible)
        store.toggleNavigation()
        #expect(store.navigationVisible)
        // Re-armed to the current mailbox's slot: Bin / Trash is index 2.
        #expect(store.navigationIndex == 2)

        // Closing re-arms next time (still to the then-current mailbox).
        store.dismissNavigation()
        #expect(!store.navigationVisible)

        store.mailbox = .spam
        store.toggleNavigation()
        #expect(store.navigationIndex == 1)
    }

    @Test func navigationMovesClampedAndActivatesMailboxSwitches() {
        let store = makeStore(inbox: [Fixtures.email(id: 1)])
        store.toggleNavigation()
        #expect(store.navigationIndex == 0)

        store.moveNavigationSelection(1)
        #expect(store.navigationIndex == 1)      // Spam
        store.moveNavigationSelection(1)
        #expect(store.navigationIndex == 2)      // Bin / Trash
        store.moveNavigationSelection(5)
        #expect(store.navigationIndex == 3)      // Settings (clamped)
        store.moveNavigationSelection(-1)
        #expect(store.navigationIndex == 2)      // back to Bin / Trash

        store.apply(.activateNavigation)
        #expect(store.mailbox == .trash)
        #expect(!store.navigationVisible)
    }

    @Test func navigationActivatingSettingsRequestsTheSettingsWindow() {
        let store = makeStore()
        store.moveNavigationSelection(3)         // Settings
        let before = store.settingsRequestToken
        store.activateNavigation()
        #expect(store.settingsRequestToken == before + 1)
        #expect(!store.navigationVisible)
        #expect(store.mailbox == .inbox)
    }

    @Test func mailboxSwitchSyncsThePaletteCursor() {
        let store = makeStore()
        store.mailbox = .archive
        #expect(store.navigationIndex == NavigationItem.index(for: .archive))
        store.mailbox = .inbox
        #expect(store.navigationIndex == 0)
    }

    @Test func signOutResetsNavigationState() async {
        let store = makeStore()
        store.toggleNavigation()
        store.moveNavigationSelection(3)
        await store.signIn()
        store.signOut()
        #expect(!store.navigationVisible)
        #expect(store.navigationIndex == 0)
    }

    // MARK: Thread grouping & conversations (STO-124)

    @Test func messagesSharingAThreadCollapseIntoOneRowNewestRepresentativeWins() {
        let store = makeStore(inbox: [
            Fixtures.email(id: 1, threadId: "t-1", receivedAt: 1, subject: "Oldest"),
            Fixtures.email(id: 2, threadId: "t-1", receivedAt: 2, subject: "Newest"),
            Fixtures.email(id: 3, threadId: "t-2", receivedAt: 3, subject: "Other"),
            Fixtures.email(id: 4, receivedAt: 4, subject: "Standalone"),
        ])

        // The conversation-aware list collapses the pair into one row.
        #expect(store.filteredThreads.count == 3)
        let pairIndex = store.filteredThreads.firstIndex { $0.id == 2 }
        #expect(pairIndex != nil)
        let pair = store.filteredThreads[pairIndex!]
        // Representative is the newest member; id is the representative's id.
        #expect(pair.conversationCount == 2)
        #expect(pair.representative.id == 2)
        // Messages stay oldest → newest inside the row.
        #expect(pair.messages.map(\.id) == [1, 2])
        // nil-thread mail stays standalone (and the list is newest-first).
        #expect(store.filteredThreads[0].id == 4)
        #expect(store.filteredThreads[0].conversationCount == 1)

        // Cursor/open bookkeeping keys off the representative.
        store.moveSelection(pairIndex! + 1)
        #expect(store.selectedRowIndex == pairIndex)
        store.openSelected()
        #expect(store.selectedEmailID == 2)
    }

    @Test func openingAMemberMovesTheCursorToItsThreadAndMarksThatMessageRead() {
        let store = makeStore(inbox: [
            Fixtures.email(id: 1, threadId: "t-1", receivedAt: 1, subject: "Old", unread: true),
            Fixtures.email(id: 2, threadId: "t-1", receivedAt: 2, subject: "New", unread: true),
            Fixtures.email(id: 3, threadId: "t-2", receivedAt: 3, subject: "Other"),
        ])

        store.openEmail(1)
        #expect(store.selectedEmailID == 1)
        // Wherever you click, the cursor lands on the thread's row (here row 1).
        #expect(store.selectedRowIndex == 1)
        // The opened member is marked read; its sibling stays unread.
        #expect(store.inbox.first(where: { $0.id == 1 })?.unread == false)
        #expect(store.inbox.first(where: { $0.id == 2 })?.unread == true)
    }

    @Test func conversationUnionsMailboxesAndOrdersOldestFirst() {
        let store = makeStore(inbox: [
            Fixtures.email(id: 1, threadId: "t-1", sender: "a@x.co", receivedAt: 5, subject: "Later"),
            Fixtures.email(id: 2, threadId: "t-1", sender: "b@x.co", receivedAt: 1, subject: "Earlier"),
        ])
        store.archived = [Fixtures.email(id: 3, threadId: "t-1", receivedAt: 3, subject: "Middle")]
        store.spam = [Fixtures.email(id: 4, threadId: "t-1", receivedAt: 4, subject: "Spam member")]

        let conversation = store.conversation(for: Fixtures.email(id: 2, threadId: "t-1", receivedAt: 1))
        #expect(conversation.map { $0.id } == [2, 3, 4, 1])

        // Standalone mail (no thread) is its own single-element conversation.
        #expect(store.conversation(for: Fixtures.email(id: 99)).map { $0.id } == [99])
    }

    @Test func conversationExcludesBlockedSenders() {
        let store = makeStore(inbox: [
            Fixtures.email(id: 1, threadId: "t-1", sender: "good@x.co", receivedAt: 1),
            Fixtures.email(id: 2, threadId: "t-1", sender: "blocked@x.co", receivedAt: 2),
        ])
        store.blockSender("blocked@x.co")
        #expect(store.conversation(for: Fixtures.email(id: 1, threadId: "t-1")).map { $0.id } == [1])
    }

    @Test func readingInsideArchiveShowsItsOwnRows() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, sender: "a@x.co")])
        store.archived = [Fixtures.email(id: 2, sender: "b@x.co")]
        store.mailbox = .archive
        store.openEmail(2)
        #expect(store.selectedEmail?.id == 2)
        store.trashEmail(2)
        #expect(store.selectedEmailID == nil)
        #expect(store.trashed.map(\.id) == [2])
    }

    // MARK: Read / unread

    @Test func openingAnEmailMarksItRead() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, unread: true)])
        store.openEmail(1)
        #expect(store.inbox.first?.unread == false)
    }

    @Test func toggleReadFlipsStateAndMarkUnreadRecovers() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, unread: false)])
        store.toggleRead(1)
        #expect(store.inbox.first?.unread == true)
        store.markRead(1)
        #expect(store.inbox.first?.unread == false)
    }

    // MARK: Blocked senders

    @Test func blockedSendersHideMailButUnblockRestoresIt() {
        let store = makeStore(inbox: [Fixtures.email(id: 1, sender: "spam@x.co"), Fixtures.email(id: 2, sender: "ok@x.co")])

        store.blockSender("spam@x.co")
        #expect(store.emails(for: .inbox).map(\.id) == [2])
        // List view follows the same filter.
        #expect(store.filteredEmails.map(\.email.id) == [2])
        // The cache-side inbox is unchanged — blocking stays a view concern.
        #expect(store.inbox.count == 2)

        store.unblockSender("spam@x.co")
        #expect(store.emails(for: .inbox).map(\.id).sorted() == [1, 2])
    }

    @Test func blockedSendersPersistInTheDefaultsDomain() {
        let suite = "winnow.tests.block.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = WinnowStore(learning: LearningModel(defaults: defaults), defaults: defaults)
        store.blockSender("n@x.co")
        let reloaded = WinnowStore(learning: LearningModel(defaults: defaults), defaults: defaults)
        #expect(reloaded.isSenderBlocked("n@x.co"))
    }
}

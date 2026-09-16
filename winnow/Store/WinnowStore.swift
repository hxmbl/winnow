import Foundation
import SwiftUI
import UserNotifications

/// Holds all Winnow UI state. The backend (Gmail OAuth) is intentionally not
/// implemented — the app runs on mock data, like the pre-login demo it mirrors.
///
/// Derived data (profile, signals, filtered rows) is *cached*: the classification
/// pipeline is regex-heavy, so it runs once per input change instead of on every
/// view render. Inputs invalidate via `didSet`; reads are plain property access.
///
/// Invalidation is incremental. A data change (star toggle, trash edit)
/// reclassifies only the emails whose content changed or whose sender's
/// standing in the profile shifted; weight changes are debounced into one full
/// sweep shortly after the last tick so Settings slider drags never stall the
/// main thread.
@MainActor
@Observable
final class WinnowStore {
    /// User-chosen appearance. `system` follows the OS; the others pin a scheme.
    enum Appearance: String, CaseIterable, Identifiable {
        case system, light, dark
        var id: String { rawValue }
        var label: String {
            switch self {
            case .system: return "System"
            case .light: return "Light"
            case .dark: return "Dark"
            }
        }
    }

    // MARK: - Editable state

    static let authDefaultsKey = "winnow.authed.v1"
    static let blockedSendersKey = "winnow.blockedSenders.v1"
    static let notificationsEnabledKey = "winnow.notificationsEnabled.v1"

    var authed = false

    /// Active smart-filter / sender selection. Drives `filteredEmails`; the
    /// sidebar and the pill bar both toggle into this single source of truth.
    var activeFilters: [FilterId] = [] {
        didSet { rebuildFilteredRows() }
    }

    var searchQuery = "" {
        didSet {
            let trimmed = searchQuery.trimmingCharacters(in: .whitespaces)
            if trimmed != lastFilteredQuery {
                lastFilteredQuery = trimmed
                rebuildFilteredRows()
            }
        }
    }

    var sortBy: SortBy = .date {
        didSet { rebuildFilteredRows() }
    }

    var loading = false

    var inbox: [WinnowEmail] = mockInbox {
        didSet { rebuildAllDerived(previousInbox: oldValue) }
    }

    /// Archived mail (All Mail minus Inbox/Trash in live mode; empty in demo).
    /// Not classified — triage happens in the inbox; these are kept for
    /// browsing and un-archiving.
    var archived: [WinnowEmail] = [] {
        didSet { rebuildFilteredRows() }
    }

    /// Hard-deleted or trashed mail shown in the Trash mailbox.
    var trashed: [WinnowEmail] = [] {
        didSet { rebuildFilteredRows() }
    }

    /// The mailbox currently on screen. Owned here (not in the view) so
    /// keybinds and actions can act on whatever list the user is looking at.
    var mailbox: Mailbox = .inbox {
        didSet {
            // A mailbox switch resets the reader card and keyboard cursor —
            // selection is per-list, never carried across views.
            selectedEmailID = nil
            selectedRowIndex = nil
            rebuildFilteredRows()
        }
    }

    /// Senders the user has blocked in Settings; their mail is hidden from
    /// every mailbox list (still present in the cache until the next sync
    /// drops it — blocking is a view concern, unblocking must bring it back).
    private(set) var blockedSenders: [String] {
        didSet { defaults.set(blockedSenders, forKey: Self.blockedSendersKey) }
    }

    /// User opt-in for new-email notifications (Settings).
    var notificationsEnabled = false {
        didSet { defaults.set(notificationsEnabled, forKey: Self.notificationsEnabledKey) }
    }

    var trash: [TrashRow] = mockTrash {
        // Trash only moves profile stats, so the inbox itself is unchanged.
        didSet { rebuildAllDerived(previousInbox: inbox) }
    }

    /// User-chosen color scheme; `nil` follows the system.
    var chosenScheme: ColorScheme?

    /// The email shown in the floating reader card. Resolved against the full
    /// inbox (not the filtered list), so starring inside the card keeps it live
    /// even when filters would hide its row.
    var selectedEmailID: Int?

    /// Keyboard cursor: index into `filteredEmails`. Independent of the open
    /// card — `j/k` move it, `Enter/o` opens it, clicking a row syncs it.
    private(set) var selectedRowIndex: Int?

    /// Bumped to ask the view to focus the search field (keybind `/`).
    /// Observed (not ignored) so `.onChange` in views fires on the bump.
    var searchFocusToken = 0
    /// Bumped to ask the reader card to focus the reply composer (keybind `r`).
    var composerFocusToken = 0
    /// Keyboard-shortcuts cheat sheet visibility (keybind `?`).
    var showShortcutOverlay = false

    /// Tunable/learned classification weights + feedback log. Weight changes
    /// re-run the whole pipeline via `onWeightsChanged`. Injectable so tests can
    /// run against an isolated `UserDefaults` domain.
    let learning: LearningModel

    // MARK: - Live Gmail backend

    /// Everything needed to talk to a real Gmail account, created on
    /// successful sign-in. `nil` ⇒ demo mode on mock data.
    ///
    /// MODE LOGIC (deliberately explicit):
    /// - `startSignIn()`: credentials present → live auth + sync; absent → demo.
    ///   A failed live attempt keeps `authed == false` and records
    ///   `lastAuthError` for the login screen.
    /// - Launch with `authed == true` and stored tokens → silent restore.
    /// - `signOut()`: clears tokens (Keychain), wipes the local mail cache,
    ///   then restores demo state.
    struct LiveBackend {
        let client: GmailClient
        let sync: GmailSyncEngine
        let cache: EmailCacheStore
        let tokens: TokenManager
    }

    private(set) var liveBackend: LiveBackend?
    /// Injectable so tests force demo mode even when the host app bundle
    /// carries real `GmailCredentials.plist`.
    @ObservationIgnored var isLiveModeAvailable: () -> Bool = { (try? GmailCredentials.load()) != nil }
    /// Last sign-in or sync failure, for display. Never contains token data.
    private(set) var lastAuthError: String?
    private(set) var syncing = false
    /// Last background action failure (e.g. a star that didn't reach Google).
    private(set) var syncError: String?
    /// Clears the visible sync-failure banner once the user has seen it.
    func dismissSyncError() {
        syncError = nil
    }
    /// True while the interactive sign-in (browser round-trip) is running.
    private(set) var isSigningIn = false
    @ObservationIgnored private var signInTask: Task<Void, Never>?

    // MARK: - Derived data (cached, read-only)

    /// Rebuilt only when `inbox`/`trash` change.
    private(set) var profile: UserProfile = UserProfile(trashBiasBySender: [:], topSenders: [], quietSenders: [])

    /// Per-email classification, keyed by email id — one regex pass per input change.
    private(set) var emailSignals: [Int: EmailSignals] = [:]

    /// Lowercased search haystack per email id, rebuilt alongside signals so
    /// typing never re-concatenates + lowercases every message body per keystroke.
    private(set) var searchBags: [Int: String] = [:]

    /// Filter pills ordered by group then current match count (`rankFilters`),
    /// refreshed whenever profile or signals change.
    private(set) var railItems: [FilterRailItem] = []

    /// Filtered + sorted rows with their signals attached, ready for rendering.
    private(set) var filteredEmails: [EmailRowModel] = []

    /// Query the current `filteredEmails` was built from (trimmed), so keystrokes
    /// that don't change the effective query skip the rebuild.
    @ObservationIgnored private var lastFilteredQuery = ""

    /// Coalesces bursts of weight changes (Settings slider ticks) into a single
    /// full reclassification after the last tick, keeping drags smooth.
    @ObservationIgnored private var weightsSweepTask: Task<Void, Never>?

    /// Deltas larger than this (a first live sync replacing the whole inbox)
    /// classify **off the main thread**: rows appear progressively instead of
    /// beachballing. Small deltas (tests, single edits) stay synchronous so
    /// derived data is immediately consistent.
    @ObservationIgnored static let syncClassifyThreshold = 200
    @ObservationIgnored private var backgroundClassifyTask: Task<Void, Never>?
    @ObservationIgnored private var isClassifyingInBackground = false

    /// Flushes learning weights to disk when the app terminates (the debounced
    /// persist would otherwise lose the last ~200ms of edits).
    @ObservationIgnored private var terminateObserver: NSObjectProtocol?

    @ObservationIgnored private let defaults: UserDefaults

    // MARK: - Lifecycle & rebuilds

    /// True when this process hosts the unit-test bundle (the host app launches
    /// with the user's real defaults, whose persisted `authed` + Keychain
    /// tokens would kick off a live sync at startup and stall the runner).
    @ObservationIgnored nonisolated static let isRunningUnderTestHost =
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    /// Injectable so tests can run against isolated `UserDefaults` domains.
    init(learning: LearningModel, defaults: UserDefaults = .standard) {
        self.learning = learning
        self.defaults = defaults
        self.authed = defaults.bool(forKey: Self.authDefaultsKey)
        self.blockedSenders = defaults.stringArray(forKey: Self.blockedSendersKey) ?? []
        self.notificationsEnabled = defaults.bool(forKey: Self.notificationsEnabledKey)
        learning.onWeightsChanged = { [weak self] in self?.scheduleWeightsSweep() }
        rebuildAllDerived()
        terminateObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.learning.flushPendingPersist()
            }
        }
        if authed, !Self.isRunningUnderTestHost {
            Task { await restoreLiveSessionIfPossible() }
        }
    }

    /// Stock store on the shared standard defaults.
    convenience init() {
        self.init(learning: LearningModel())
    }

    /// Rebuilds the profile, patches cached signals incrementally, and refreshes
    /// the visible rows.
    ///
    /// - Parameter previousInbox: The inbox before the change that triggered
    ///   this rebuild. `nil` forces a full classification pass (initial build,
    ///   weight sweeps).
    private func rebuildAllDerived(previousInbox: [WinnowEmail]? = nil) {
        let newProfile = buildUserProfile(inbox: inbox, trash: trash)

        var dirtyIDs: Set<Int>
        if previousInbox == nil || emailSignals.isEmpty {
            dirtyIDs = Set(inbox.map(\.id))
        } else {
            dirtyIDs = changedEmailIDs(from: previousInbox!)
            dirtyIDs.formUnion(senderStandingShifts(oldProfile: profile, newProfile: newProfile))
            for email in inbox where emailSignals[email.id] == nil {
                dirtyIDs.insert(email.id)
            }
        }

        profile = newProfile

        if dirtyIDs.count > Self.syncClassifyThreshold {
            classifyInBackground(dirtyIDs: dirtyIDs, profile: newProfile)
        } else if !dirtyIDs.isEmpty {
            var updated = emailSignals
            var updatedBags = searchBags
            let weights = learning.weights
            for email in inbox where dirtyIDs.contains(email.id) {
                updated[email.id] = classifyEmail(email: email, profile: newProfile, weights: weights)
                updatedBags[email.id] = wordBag(email)
            }
            // Drop cached entries for emails that no longer exist.
            let liveIDs = Set(inbox.map(\.id))
            emailSignals = updated.filter { liveIDs.contains($0.key) }
            searchBags = updatedBags.filter { liveIDs.contains($0.key) }
        }

        updateRailItems()
        rebuildFilteredRows()
    }

    /// Classifies a large delta off the main actor and merges the results back
    /// when the inbox is still what they were computed from; otherwise the
    /// rebuild simply re-runs (converging once changes settle).
    private func classifyInBackground(dirtyIDs: Set<Int>, profile newProfile: UserProfile) {
        isClassifyingInBackground = true
        backgroundClassifyTask?.cancel()
        let capturedInbox = inbox
        let capturedWeights = learning.weights
        backgroundClassifyTask = Task { [weak self] in
            let computed = await Task.detached(priority: .userInitiated) { () -> ([Int: EmailSignals], [Int: String]) in
                var signals: [Int: EmailSignals] = [:]
                var bags: [Int: String] = [:]
                signals.reserveCapacity(dirtyIDs.count)
                for email in capturedInbox where dirtyIDs.contains(email.id) {
                    signals[email.id] = classifyEmail(email: email, profile: newProfile, weights: capturedWeights)
                    bags[email.id] = wordBag(email)
                }
                return (signals, bags)
            }.value

            guard let self, !Task.isCancelled else { return }
            self.applyBackgroundClassification(signals: computed.0, bags: computed.1, computedFor: capturedInbox)
        }
    }

    private func applyBackgroundClassification(
        signals: [Int: EmailSignals],
        bags: [Int: String],
        computedFor capturedInbox: [WinnowEmail]
    ) {
        guard inbox == capturedInbox else {
            // Inbox moved on while we computed — redo against the new state.
            isClassifyingInBackground = false
            rebuildAllDerived(previousInbox: nil)
            return
        }
        for (id, sig) in signals { emailSignals[id] = sig }
        for (id, bag) in bags { searchBags[id] = bag }
        let liveIDs = Set(inbox.map(\.id))
        emailSignals = emailSignals.filter { liveIDs.contains($0.key) }
        searchBags = searchBags.filter { liveIDs.contains($0.key) }
        isClassifyingInBackground = false
        updateRailItems()
        rebuildFilteredRows()
    }

    private func updateRailItems() {
        railItems = FilterRailLayout.items(
            from: rankFilters(inbox: inbox, signals: emailSignals, profile: profile)
        )
    }

    /// Emails whose content differs from the previous inbox (including added ones).
    private func changedEmailIDs(from previousInbox: [WinnowEmail]) -> Set<Int> {
        let oldByEmail: [Int: WinnowEmail] = Dictionary(
            previousInbox.map { (id: $0.id, email: $0) },
            uniquingKeysWith: { first, _ in first }
        )
        var dirty = Set<Int>()
        for email in inbox where oldByEmail[email.id] != email {
            dirty.insert(email.id)
        }
        return dirty
    }

    /// Emails whose sender's standing changed between profiles — their
    /// importance score depends on top-sender tier, quiet membership, and
    /// trash bias even when the email itself is untouched. Both profiles are
    /// read through `UserProfile.standing(for:)`, the same accessor the tier
    /// and bias-cap logic in `Scoring`/`Classifier` consume, so this check
    /// cannot drift from what classification actually uses.
    private func senderStandingShifts(oldProfile: UserProfile, newProfile: UserProfile) -> Set<Int> {
        let senders = Set(inbox.map(\.sender))
        var shifted = Set<String>()
        for sender in senders where oldProfile.standing(for: sender) != newProfile.standing(for: sender) {
            shifted.insert(sender)
        }
        guard !shifted.isEmpty else { return [] }

        var dirty = Set<Int>()
        for email in inbox where shifted.contains(email.sender) {
            dirty.insert(email.id)
        }
        return dirty
    }

    /// Schedules one full reclassification shortly after the latest weight
    /// change. Rapid-fire events replace each other instead of stacking work.
    /// The regex-heavy pass itself runs off the main actor; results are applied
    /// back here only if inbox, trash, and weights all still match what they
    /// were computed from — otherwise the sweep simply reschedules and
    /// converges on fresh inputs.
    private func scheduleWeightsSweep() {
        weightsSweepTask?.cancel()
        weightsSweepTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 80_000_000)
            guard let self, !Task.isCancelled else { return }
            await self.runWeightsSweep()
        }
    }

    private func runWeightsSweep() async {
        let capturedInbox = inbox
        let capturedTrashSenders = trash.map(\.sender)
        let capturedWeights = learning.weights

        let computed = await Task.detached(priority: .userInitiated) { () -> (UserProfile, [Int: EmailSignals]) in
            let trash = capturedTrashSenders.map { TrashRow(sender: $0) }
            let profile = buildUserProfile(inbox: capturedInbox, trash: trash)
            var signals: [Int: EmailSignals] = [:]
            signals.reserveCapacity(capturedInbox.count)
            for email in capturedInbox {
                signals[email.id] = classifyEmail(email: email, profile: profile, weights: capturedWeights)
            }
            return (profile, signals)
        }.value

        guard !Task.isCancelled,
              inbox == capturedInbox,
              trash.map(\.sender) == capturedTrashSenders,
              learning.weights == capturedWeights else {
            scheduleWeightsSweep()
            return
        }

        let liveIDs = Set(inbox.map(\.id))
        profile = computed.0
        emailSignals = computed.1.filter { liveIDs.contains($0.key) }
        updateRailItems()
        rebuildFilteredRows()
    }

    private func rebuildFilteredRows() {
        let visible = emails(for: mailbox)
        let visibleIDs = filterAndSortInbox(
            inbox: visible,
            filters: activeFilters,
            searchQuery: searchQuery,
            sortBy: sortBy,
            profile: profile,
            signals: emailSignals,
            searchBags: searchBags
        )
        var rows: [EmailRowModel] = []
        rows.reserveCapacity(visibleIDs.count)
        for email in visibleIDs {
            // Archived/trashed mail is never classified (triage lives in the
            // inbox), so those rows render with a neutral signal.
            let sig = emailSignals[email.id] ?? .neutral
            rows.append(EmailRowModel(email: email, sig: sig))
        }
        filteredEmails = rows
        lastFilteredQuery = searchQuery.trimmingCharacters(in: .whitespaces)

        // Keep the keyboard cursor inside the (possibly shrunk) list.
        if filteredEmails.isEmpty {
            selectedRowIndex = nil
        } else if let index = selectedRowIndex {
            selectedRowIndex = min(max(0, index), filteredEmails.count - 1)
        }
        // During a background classification pass, inbox rows without signals
        // yet are "pending", not a bug — they fill in as the pass completes.
        // Archived/trashed rows intentionally render with neutral signals.
        if !isClassifyingInBackground, mailbox == .inbox {
            let missing = filteredEmails.contains { emailSignals[$0.email.id] == nil }
            assert(!missing, "Inbox rows without cached signals outside a background classify window")
        }
    }

    // MARK: - Keyboard navigation

    /// The id the keyboard currently targets: the open card if present, else
    /// the cursor row.
    private var focusedEmailID: Int? {
        selectedEmailID ?? {
            guard let i = selectedRowIndex, filteredEmails.indices.contains(i) else { return nil }
            return filteredEmails[i].email.id
        }()
    }

    /// Moves the cursor by `delta` rows, clamped. When the reader card is
    /// open the cursor drag it along — `j/k` become "next/previous message".
    func moveSelection(_ delta: Int) {
        guard !filteredEmails.isEmpty else { return }
        let current = selectedRowIndex ?? (delta > 0 ? -1 : filteredEmails.count)
        let next = min(max(0, current + delta), filteredEmails.count - 1)
        selectedRowIndex = next
        if selectedEmailID != nil {
            openEmail(filteredEmails[next].email.id)
        }
    }

    /// Opens whichever email the keyboard is on.
    func openSelected() {
        guard let index = selectedRowIndex, filteredEmails.indices.contains(index) else { return }
        openEmail(filteredEmails[index].email.id)
    }

    /// Executes a keybind command. The single place key semantics touch state.
    func apply(_ command: KeyCommand) {
        switch command {
        case .moveSelection(let delta):
            moveSelection(delta)
        case .openSelected:
            openSelected()
        case .closeViewer:
            dismissEmail()
        case .dismissOverlay:
            showShortcutOverlay = false
        case .toggleShortcutsOverlay:
            showShortcutOverlay.toggle()
        case .toggleStar:
            if let id = focusedEmailID { toggleStar(id) }
        case .archive:
            if let id = focusedEmailID {
                // Context-sensitive: `e` archives from the inbox, restores
                // from the archive, and un-trashes from the trash mailbox.
                switch mailbox {
                case .inbox: archiveEmail(id)
                case .archive: unarchiveEmail(id)
                case .trash: restoreEmail(id)
                }
            }
        case .trash:
            if let id = focusedEmailID {
                switch mailbox {
                case .trash: deleteEmail(id)   // permanent delete in Trash
                default: trashEmail(id)
                }
            }
        case .restore:
            if let id = focusedEmailID { restoreEmail(id) }
        case .toggleRead:
            if let id = focusedEmailID { toggleRead(id) }
        case .focusReply:
            guard selectedEmail != nil else { return }
            composerFocusToken += 1
        case .focusSearch:
            searchFocusToken += 1
        case .toggleFilter(let railIndex):
            guard railItems.indices.contains(railIndex) else { return }
            toggleFilter(.builtin(railItems[railIndex].filter.id))
        case .blurText:
            NSApp.keyWindow?.makeFirstResponder(nil)
        }
    }

    // MARK: - Mailbox plumbing

    /// The email list backing a mailbox view, with blocked senders removed.
    /// (Unblocking restores the row without a sync — blocking is purely a
    /// view concern, the cache keeps the message.)
    func emails(for mailbox: Mailbox) -> [WinnowEmail] {
        let base: [WinnowEmail]
        switch mailbox {
        case .inbox: base = inbox
        case .archive: base = archived
        case .trash: base = trashed
        }
        return base.filter { !isSenderBlocked($0.sender) }
    }

    private func email(_ id: Int, in mailbox: Mailbox) -> WinnowEmail? {
        switch mailbox {
        case .inbox: return inbox.first { $0.id == id }
        case .archive: return archived.first { $0.id == id }
        case .trash: return trashed.first { $0.id == id }
        }
    }

    private func setEmail(_ email: WinnowEmail, in mailbox: Mailbox) {
        switch mailbox {
        case .inbox:
            guard let i = inbox.firstIndex(where: { $0.id == email.id }) else { return }
            inbox[i] = email
        case .archive:
            guard let i = archived.firstIndex(where: { $0.id == email.id }) else { return }
            archived[i] = email
        case .trash:
            guard let i = trashed.firstIndex(where: { $0.id == email.id }) else { return }
            trashed[i] = email
        }
    }

    @discardableResult
    private func removeEmail(_ id: Int, from mailbox: Mailbox) -> WinnowEmail? {
        switch mailbox {
        case .inbox:
            guard let i = inbox.firstIndex(where: { $0.id == id }) else { return nil }
            return inbox.remove(at: i)
        case .archive:
            guard let i = archived.firstIndex(where: { $0.id == id }) else { return nil }
            return archived.remove(at: i)
        case .trash:
            guard let i = trashed.firstIndex(where: { $0.id == id }) else { return nil }
            return trashed.remove(at: i)
        }
    }

    private func insertEmail(_ email: WinnowEmail, into mailbox: Mailbox) {
        switch mailbox {
        case .inbox: inbox.insert(email, at: 0)
        case .archive: archived.insert(email, at: 0)
        case .trash: trashed.insert(email, at: 0)
        }
    }

    /// Which bucket a numeric id currently lives in, if any.
    private func containingMailbox(of id: Int) -> Mailbox? {
        if inbox.contains(where: { $0.id == id }) { return .inbox }
        if archived.contains(where: { $0.id == id }) { return .archive }
        if trashed.contains(where: { $0.id == id }) { return .trash }
        return nil
    }

    // MARK: - Mailbox moves

    /// Archive: live mode removes the INBOX label server-side. Demo mode just
    /// relocates the email into the archive list. While reading, this is
    /// triage: the next email opens automatically so `e j j e` never touches
    /// the mouse.
    func archiveEmail(_ emailID: Int) {
        relocate(emailID, to: .archive) { client, gmailID in
            try await client.modify(messageID: gmailID, addLabelIds: nil, removeLabelIds: [GmailLabel.inbox])
        }
    }

    /// Brings an archived email back to the inbox (live: adds the INBOX label).
    func unarchiveEmail(_ emailID: Int) {
        relocate(emailID, to: .inbox) { client, gmailID in
            try await client.modify(messageID: gmailID, addLabelIds: [GmailLabel.inbox], removeLabelIds: nil)
        }
    }

    /// Trash: live mode hits the trash endpoint and records the sender in the
    /// local trash fixture (feeding trash-bias learning); demo mode local-only.
    func trashEmail(_ emailID: Int) {
        relocate(emailID, to: .trash) { client, gmailID in
            try await client.trash(messageID: gmailID)
        }
    }

    /// Restores a trashed message to the inbox (live: drops TRASH, adds INBOX).
    func restoreEmail(_ emailID: Int) {
        relocate(emailID, to: .inbox) { client, gmailID in
            try await client.modify(messageID: gmailID, addLabelIds: [GmailLabel.inbox], removeLabelIds: [GmailLabel.trash])
        }
    }

    /// Permanently removes a message from Gmail. Irreversible — only reachable
    /// from the Trash mailbox (and rolled back if the server round-trip fails).
    func deleteEmail(_ emailID: Int) {
        guard let email = removeEmail(emailID, from: .trash) else { return }
        let wasOpen = selectedEmailID == emailID
        let gmailID = liveBackend?.cache.gmailID(for: emailID)
        if let backend = liveBackend, let gmailID {
            try? backend.cache.remove(gmailIds: [gmailID])
            let client = backend.client
            let cache = backend.cache
            Task { [weak self] in
                do {
                    try await client.deletePermanent(messageID: gmailID)
                } catch {
                    self?.rollbackDelete(email, gmailID: gmailID, cache: cache, wasOpen: wasOpen, error: error)
                }
            }
        }
        applyPostMoveCursor(removedID: emailID, wasOpen: wasOpen)
    }

    /// A permanent delete that hit the network and failed — the message is
    /// gone from every bucket; put it back in Trash and in the cache.
    private func rollbackDelete(_ email: WinnowEmail, gmailID: String, cache: EmailCacheStore, wasOpen: Bool, error: Error) {
        syncError = Self.rawDescription(of: error)
        guard containingMailbox(of: email.id) == nil else { return }
        let restored = email
        insertEmail(restored, into: .trash)
        try? cache.upsert(
            email: restored,
            gmailId: gmailID,
            threadId: cache.threadID(for: email.id) ?? "",
            mailbox: .trash
        )
        if wasOpen {
            openEmail(email.id)
        } else if let row = filteredEmails.firstIndex(where: { $0.email.id == email.id }) {
            selectedRowIndex = row
        }
    }

    /// Shared move mechanics: relocate a message across mailbox buckets
    /// optimistically (cache bucket + view list), then reconcile with the
    /// server in the background.
    /// **Rollback**: failed server calls restore the message locally — an
    /// optimistic move must never become silently missing mail.
    private func relocate(
        _ emailID: Int,
        to destination: Mailbox,
        serverCall: @escaping (GmailClient, String) async throws -> Void
    ) {
        guard let source = containingMailbox(of: emailID), source != destination else { return }
        var email = removeEmail(emailID, from: source)!
        let wasOpen = selectedEmailID == emailID
        let gmailID = liveBackend?.cache.gmailID(for: emailID)

        // Trash-bias learning on mail that leaves the triage pipeline.
        if destination == .trash { trash.append(TrashRow(sender: email.sender)) }

        // Optimistic local state: moved mail is treated as handled/read.
        email.unread = false
        insertEmail(email, into: destination)
        if let backend = liveBackend {
            try? backend.cache.setMailbox(numericId: email.id, mailbox: destination.emailMailbox)
        }

        if let backend = liveBackend, let gmailID {
            let client = backend.client
            let cache = backend.cache
            Task { [weak self] in
                do {
                    try await serverCall(client, gmailID)
                } catch {
                    self?.rollbackRelocation(
                        email, gmailID: gmailID, cache: cache,
                        destination: destination, backTo: source,
                        wasOpen: wasOpen, error: error
                    )
                }
            }
        }

        applyPostMoveCursor(removedID: emailID, wasOpen: wasOpen)
    }

    /// Puts a failed server move back where it started: the email currently
    /// sits in `destination` (the optimistic home) and must return to `source`.
    private func rollbackRelocation(
        _ email: WinnowEmail,
        gmailID: String,
        cache: EmailCacheStore,
        destination: Mailbox,
        backTo source: Mailbox,
        wasOpen: Bool,
        error: Error
    ) {
        syncError = Self.rawDescription(of: error)
        guard containingMailbox(of: email.id) == destination else { return }
        removeEmail(email.id, from: destination)
        var restored = email
        restored.unread = true
        insertEmail(restored, into: source)
        try? cache.upsert(
            email: restored,
            gmailId: gmailID,
            threadId: cache.threadID(for: email.id) ?? "",
            mailbox: source.emailMailbox
        )
        if wasOpen {
            openEmail(email.id)
        } else if let row = filteredEmails.firstIndex(where: { $0.email.id == email.id }) {
            selectedRowIndex = row
        }
    }

    /// Cursor/card bookkeeping after a move or delete: stay at the same
    /// position — which now points at the next email — and advance an open
    /// card to it.
    private func applyPostMoveCursor(removedID: Int, wasOpen: Bool) {
        if filteredEmails.isEmpty {
            selectedRowIndex = nil
            if wasOpen { dismissEmail() }
        } else {
            let next = min(max(0, selectedRowIndex ?? 0), filteredEmails.count - 1)
            selectedRowIndex = next
            if wasOpen {
                openEmail(filteredEmails[next].email.id)
            }
        }
    }

    // MARK: - Read state

    func markRead(_ emailID: Int) { setRead(emailID, unread: false) }
    func markUnread(_ emailID: Int) { setRead(emailID, unread: true) }

    /// Flip read/unread. `m` in the keybinds.
    func toggleRead(_ emailID: Int) {
        let current = email(emailID, in: containingMailbox(of: emailID) ?? mailbox)
        setRead(emailID, unread: !(current?.unread ?? false))
    }

    /// Read state is optimistic-live: the UNREAD label flips in the cache and
    /// the list instantly, the server round-trip happens in the background.
    private func setRead(_ emailID: Int, unread: Bool) {
        guard let mailbox = containingMailbox(of: emailID), var email = email(emailID, in: mailbox), email.unread != unread else { return }
        email.unread = unread
        setEmail(email, in: mailbox)
        if let backend = liveBackend, let gmailID = backend.cache.gmailID(for: emailID) {
            try? backend.cache.setUnread(numericId: emailID, unread: unread)
            let client = backend.client
            Task { [weak self] in
                do {
                    try await client.modify(
                        messageID: gmailID,
                        addLabelIds: unread ? [GmailLabel.unread] : nil,
                        removeLabelIds: unread ? nil : [GmailLabel.unread]
                    )
                } catch {
                    self?.syncError = Self.rawDescription(of: error)
                }
            }
        }
    }

    // MARK: - Blocked senders (Settings)

    func isSenderBlocked(_ sender: String) -> Bool {
        blockedSenders.contains(sender)
    }

    /// Blocks a sender: their mail hides from every mailbox. Unblock restores.
    func blockSender(_ sender: String) {
        guard !isSenderBlocked(sender) else { return }
        blockedSenders.append(sender)
        rebuildFilteredRows()
    }

    func unblockSender(_ sender: String) {
        guard isSenderBlocked(sender) else { return }
        blockedSenders.removeAll { $0 == sender }
        rebuildFilteredRows()
    }

    // MARK: - Reader-card selection

    /// The selected thread resolved against the **current mailbox**, or nil
    /// when the id no longer exists there (e.g. after a move or sign-out).
    var selectedEmail: WinnowEmail? {
        guard let id = selectedEmailID else { return nil }
        return emails(for: mailbox).first { $0.id == id }
    }

    func openEmail(_ id: Int) {
        selectedEmailID = id
        // Clicking a row moves the keyboard cursor with it.
        if let index = filteredEmails.firstIndex(where: { $0.email.id == id }) {
            selectedRowIndex = index
        }
        // Opening a message marks it read — triage that surfaces new mail
        // straight into the read (and unread-dot-free) pipeline.
        if let email = emails(for: mailbox).first(where: { $0.id == id }),
           email.unread {
            markRead(id)
        }
    }

    func dismissEmail() {
        selectedEmailID = nil
    }

    // MARK: - Appearance

    var appearance: Appearance {
        get {
            switch chosenScheme {
            case .dark: return .dark
            case .light: return .light
            default: return .system
            }
        }
        set {
            switch newValue {
            case .system: chosenScheme = nil
            case .light: chosenScheme = .light
            case .dark: chosenScheme = .dark
            }
        }
    }

    // MARK: - Cheap derived values

    /// Title for the list column: the mailbox name, or the active filter bucket
    /// when one is applied inside the inbox.
    var listTitle: String {
        guard mailbox != .inbox else {
            guard !activeFilters.isEmpty else { return "Inbox" }
            let builtinLabels = activeFilters.compactMap { filter in
                if case .builtin(let builtin) = filter {
                    builtin.label
                } else {
                    nil
                }
            }
            if builtinLabels.isEmpty {
                if case .sender(let sender) = activeFilters[0] {
                    return "From \(sender)"
                }
            }
            // A lone built-in bucket shows its name; any combination shows "Filtered".
            return builtinLabels.count == 1 ? builtinLabels[0] : "Filtered"
        }
        return mailbox.label
    }

    // MARK: - Actions

    /// Toggle a filter pill. "Unsafe" is exclusive (replaces the others); every
    /// other bucket combines, so several can be active at once.
    func toggleFilter(_ id: FilterId) {
        if activeFilters.contains(id) {
            activeFilters.removeAll { $0 == id }
        } else if id.isUnsafe {
            activeFilters = [id]
        } else {
            activeFilters.append(id)
        }
    }

    /// Clear every active filter and return to the unfiltered inbox.
    func clearAllFilters() {
        activeFilters = []
    }

    /// Star/unstar an email and feed the outcome back to the learner.
    /// Feedback is recorded *before* the flip so the event captures what the
    /// engine predicted at the moment the user decided.
    ///
    /// Live mode: the flip is optimistic-local; the STARRED label change goes
    /// to the server in the background. A failed round-trip is recorded in
    /// `syncError` but the local star stands (next sync reconciles).
    func toggleStar(_ emailID: Int) {
        guard let mailbox = containingMailbox(of: emailID), var now = email(emailID, in: mailbox) else { return }
        let nowStarred = !now.starred
        if let sig = emailSignals[emailID] {
            learning.record(action: nowStarred ? .starred : .unstarred, email: now, sig: sig)
        }
        now.starred = nowStarred
        setEmail(now, in: mailbox)

        if let backend = liveBackend, let gmailID = backend.cache.gmailID(for: emailID) {
            try? backend.cache.setStarred(numericId: emailID, starred: nowStarred)
            let labels: [String] = nowStarred ? [GmailLabel.starred] : []
            let removals: [String] = nowStarred ? [] : [GmailLabel.starred]
            Task { [weak self] in
                do {
                    try await backend.client.modify(
                        messageID: gmailID,
                        addLabelIds: labels.isEmpty ? nil : labels,
                        removeLabelIds: removals.isEmpty ? nil : removals
                    )
                } catch {
                    self?.syncError = error.localizedDescription
                }
            }
        }
    }

    // MARK: - Sending (live mode)

    enum SendOutcome: Equatable {
        case sent
        case demo
        case failed(String)
    }

    /// Sends a reply through Gmail when live; demo mode reports `.demo` so the
    /// UI can say so honestly. Attachment URLs come from the file importer and
    /// are read under their security scope **off the main actor** — a large
    /// PDF must not freeze the list while it's read and base64'd.
    func sendReply(to email: WinnowEmail, body: String, attachmentURLs: [URL]) async -> SendOutcome {
        guard let backend = liveBackend else { return .demo }
        do {
            let threadID = backend.cache.threadID(for: email.id).flatMap { $0.isEmpty ? nil : $0 }
            let draft = OutgoingDraft(
                to: email.displayAddress,
                subject: email.subject.hasPrefix("Re:") ? email.subject : "Re: " + email.subject,
                body: body,
                attachments: [],
                threadID: threadID,
                inReplyToMessageID: nil
            )
            let mime = try await Task.detached(priority: .userInitiated) { () -> Data in
                let attachments = try attachmentURLs.map { url -> OutgoingAttachment in
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    let data = try Data(contentsOf: url)
                    return OutgoingAttachment(
                        filename: url.lastPathComponent,
                        mimeType: Self.mimeType(for: url),
                        data: data
                    )
                }
                return MIMEBuilder.build(OutgoingDraft(to: draft.to, subject: draft.subject, body: draft.body, attachments: attachments, threadID: draft.threadID, inReplyToMessageID: nil))
            }.value
            _ = try await backend.client.send(GmailSendRequest(raw: Base64URL.encode(mime), threadId: threadID))
            return .sent
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    /// Runs inside the detached MIME-builder task, so it must stay callable
    /// off the main actor.
    nonisolated private static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "pdf": return "application/pdf"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "txt": return "text/plain"
        case "zip": return "application/zip"
        default: return "application/octet-stream"
        }
    }

    // MARK: - Learning bindings (Settings)

    func learningWeightBinding(_ key: SignalKey) -> Binding<Double> {
        Binding(
            get: { self.learning.weight(key) },
            set: { self.learning.setWeight(key, $0) }
        )
    }

    func adaptiveLearningBinding() -> Binding<Bool> {
        Binding(
            get: { self.learning.adaptive },
            set: { self.learning.setAdaptive($0) }
        )
    }

    /// Sign-in: live Gmail session when credentials are configured, demo mode
    /// otherwise. Never throws at the caller — failures land in
    /// `lastAuthError` for the login screen to display. Cancellable.
    func signIn() async {
        await performSignIn()
    }

    /// Entry point for the login button: guards against double-taps opening
    /// two browser tabs, and exposes the task so it can be cancelled.
    func startSignIn() {
        guard !isSigningIn else { return }
        isSigningIn = true
        signInTask = Task { [weak self] in
            await self?.performSignIn()
        }
    }

    /// Cancels an in-flight browser sign-in.
    func cancelSignIn() {
        signInTask?.cancel()
    }

    private func performSignIn() async {
        lastAuthError = nil
        defer { isSigningIn = false }

        guard isLiveModeAvailable() else {
            // Demo mode: a beat of spinner so the click feels acknowledged.
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            authed = true
            defaults.set(true, forKey: Self.authDefaultsKey)
            return
        }
        do {
            let backend = try await makeLiveBackend(interactive: true)
            let snapshot = try await backend.sync.fullSnapshot()
            // A cancelled wait must not adopt the session anyway — the user
            // pressed Cancel; any late-completing browser flow stays dormant
            // in the Keychain for the next launch to restore.
            guard !Task.isCancelled else { return }
            liveBackend = backend
            adopt(snapshot)
            authed = true
            defaults.set(true, forKey: Self.authDefaultsKey)
            if backend.sync.lastSyncFailureCount > 0 {
                syncError = Self.syncFailureSummary(backend.sync.lastSyncFailureCount)
            }
        } catch {
            if Task.isCancelled { return }   // user cancelled: no error copy
            lastAuthError = Self.rawDescription(of: error)
            authed = false
        }
    }

    /// Relaunch path: `authed` persisted, tokens should be in the Keychain.
    /// Any failure here falls back to the login screen with the reason.
    private func restoreLiveSessionIfPossible() async {
        guard liveBackend == nil, isLiveModeAvailable() else { return }
        do {
            let backend = try await makeLiveBackend(interactive: false)
            let snapshot = try await backend.sync.incrementalSnapshot()
            // M9: the world may have moved on while we awaited the network —
            // a fast sign-out (or a manual sign-in) must win over this task.
            guard authed, liveBackend == nil else { return }
            liveBackend = backend
            adopt(snapshot)
            if backend.sync.lastSyncFailureCount > 0 {
                syncError = Self.syncFailureSummary(backend.sync.lastSyncFailureCount)
            }
        } catch {
            guard authed, liveBackend == nil else { return }
            lastAuthError = Self.rawDescription(of: error)
            authed = false
            defaults.set(false, forKey: Self.authDefaultsKey)
        }
    }

    /// Builds the live stack. `interactive` controls the missing-token case:
    /// sign-in presents the browser; session-restore does NOT pop a browser at
    /// launch — it fails and drops the user on the login screen.
    ///
    /// Nothing is installed until the caller decides the session is real:
    /// a cancelled or failed build leaves `liveBackend` untouched.
    private func makeLiveBackend(interactive: Bool) async throws -> LiveBackend {
        let tokens = TokenManager(store: KeychainTokenStore(), credentialsProvider: { try GmailCredentials.load() })
        if let loadError = tokens.loadError {
            throw loadError   // keychain failure must not silently force re-auth
        }
        if !tokens.hasSession {
            guard interactive else { throw GmailConfigError.reauthRequired }
            let auth = AuthController(tokenManager: tokens, session: GmailClient.productionSession())
            try await auth.signIn()
        }
        let client = GmailClient(tokenManager: tokens, session: GmailClient.productionSession())
        let cache = try EmailCacheStore()
        let sync = GmailSyncEngine(client: client, cache: cache)
        return LiveBackend(client: client, sync: sync, cache: cache, tokens: tokens)
    }

    /// Test seam: installs a prebuilt backend without the OAuth round-trip,
    /// mirroring the existing `isLiveModeAvailable` injection pattern.
    func injectLiveBackendForTesting(_ backend: LiveBackend) {
        liveBackend = backend
    }

    /// Pre-release: show the raw error (case + associated values) so failures
    /// are diagnosable. Swap for friendly copy at launch.
    private static func rawDescription(of error: Error) -> String {
        String(describing: error)
    }

    private static func syncFailureSummary(_ count: Int) -> String {
        "\(count) message\(count == 1 ? "" : "s") failed to download this sync — refresh to retry."
    }

    /// Reset all state back to the mock fixtures and return to the login screen.
    /// Live teardown order matters: tokens first (Keychain), then the cached
    /// mail, then the backend reference.
    func signOut() {
        signInTask?.cancel()
        backgroundClassifyTask?.cancel()
        isClassifyingInBackground = false
        if let backend = liveBackend {
            backend.tokens.clear()
            try? backend.cache.wipe()
        }
        liveBackend = nil
        lastAuthError = nil
        syncError = nil
        syncing = false
        isSigningIn = false
        authed = false
        defaults.set(false, forKey: Self.authDefaultsKey)
        // The sync cursor is account-scoped: the next sign-in (possibly a
        // different account) must not inherit it.
        defaults.removeObject(forKey: GmailSyncEngine.historyIDKey)
        inbox = mockInbox
        archived = []
        trashed = []
        blockedSenders = []
        mailbox = .inbox
        trash = mockTrash
        activeFilters = []
        searchQuery = ""
        selectedEmailID = nil
        selectedRowIndex = nil
        showShortcutOverlay = false
    }

    /// Jump to the unsafe bucket (used by Settings).
    func showUnsafe() {
        activeFilters = [.builtin(.unsafe)]
    }

    /// Live: incremental server sync. Demo: brief spinner. Reentry-guarded —
    /// a second ⌘R while one sync is running is a no-op, not duplicate work.
    func refresh() async {
        if let backend = liveBackend {
            guard !syncing else { return }
            syncing = true
            defer { syncing = false }
            do {
                let snapshot = try await backend.sync.incrementalSnapshot()
                let previousUnread = Set(unreadObserverKeys(in: inbox))
                adopt(snapshot)
                syncError = nil
                if backend.sync.lastSyncFailureCount > 0 {
                    syncError = Self.syncFailureSummary(backend.sync.lastSyncFailureCount)
                }
                if notificationsEnabled {
                    notifyForNewMail(previousUnread: previousUnread)
                }
            } catch {
                syncError = Self.rawDescription(of: error)
            }
            return
        }
        loading = true
        try? await Task.sleep(nanoseconds: 500_000_000)
        loading = false
    }

    /// Replaces the three mailbox lists with a fresh server snapshot.
    private func adopt(_ snapshot: GmailMailboxSnapshot) {
        inbox = snapshot.inbox
        archived = snapshot.archive
        trashed = snapshot.trash
    }

    /// Stable fingerprint of the unread mail the user has already seen.
    private func unreadObserverKeys(in emails: [WinnowEmail]) -> [String] {
        emails.filter { $0.unread }.map { "\($0.sender)|\($0.subject)" }
    }

    /// Surfaces previously-unseen unread mail as a system notification. Fires
    /// only on incremental refreshes — the initial sign-in sync must not bury
    /// the user under its baseline, that would be noise, not triage.
    private func notifyForNewMail(previousUnread: Set<String>) {
        let fresh = inbox.filter { email in
            email.unread && !previousUnread.contains("\(email.sender)|\(email.subject)")
        }
        guard !fresh.isEmpty else { return }
        let content = UNMutableNotificationContent()
        if fresh.count == 1, let only = fresh.first {
            content.title = only.displayName
            content.body = only.subject
        } else {
            content.title = "\(fresh.count) new messages"
            content.body = fresh.prefix(3).map(\.displayName).joined(separator: ", ")
        }
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}

import Foundation

/// A point-in-time view of every mailbox the app tracks. The store mirrors
/// these arrays into its UI state.
struct GmailMailboxSnapshot {
    let inbox: [WinnowEmail]
    let archive: [WinnowEmail]
    let trash: [WinnowEmail]
    let spam: [WinnowEmail]

    init(inbox: [WinnowEmail], archive: [WinnowEmail], trash: [WinnowEmail], spam: [WinnowEmail]) {
        self.inbox = inbox
        self.archive = archive
        self.trash = trash
        self.spam = spam
    }

    init(cache: EmailCacheStore) throws {
        inbox = try cache.all(mailbox: .inbox)
        archive = try cache.all(mailbox: .archive)
        trash = try cache.all(mailbox: .trash)
        spam = try cache.all(mailbox: .spam)
    }
}

/// Keeps the local cache aligned with the server mailbox.
///
/// LOGIC (two strategies, chosen by state)
/// - **Full sync** (first sign-in, or a `historyId` older than Google's
///   retention): page through `messages.list` for each mailbox view (`in:inbox`,
///   archived, `in:trash`), fetch each message, map, and stamp it into the
///   cache under the bucket its labels imply. Messages that fall outside every
///   bucket (permanently deleted, or moved to SENT/DRAFTS) are dropped.
/// - **Incremental sync** (every refresh after that): `history.list` since the
///   stored `historyId` — each touched message is re-fetched wholesale and
///   re-categorized, so label flips (archive ⇄ inbox ⇄ trash, read/unread,
///   star) reconcile by re-reading the message's current labels. `historyId`
///   is persisted in UserDefaults: it is an opaque sync cursor, not a secret.
/// - If the incremental cursor is invalid (HTTP 404 — history expired), the
///   engine falls back to a full sync automatically.
@MainActor
final class GmailSyncEngine {
    private let client: GmailClient
    private let cache: EmailCacheStore
    private let defaults: UserDefaults
    /// Archived view = All Mail minus the "folder-ish" buckets. Sent/drafts/
    /// spam are mail the user wrote or Google quarantined — not "archived".
    private let archiveQuery = "-in:inbox -in:trash -in:sent -in:draft -in:spam"

    static let historyIDKey = "winnow.gmail.historyId"
    private let batchSize = 25
    /// Bounded archive/trash pagination: those views can be enormous, and the
    /// app's job is triage of what matters, not a full mailbox export.
    private let broadMailboxCap = 500

    /// Messages that failed to download during the last sync (transient
    /// errors are skipped so one bad message can't abort the run). Surfaced
    /// by the store after sync completes.
    private(set) var lastSyncFailureCount = 0

    init(client: GmailClient, cache: EmailCacheStore, defaults: UserDefaults = .standard, query: String = "in:inbox") {
        self.client = client
        self.cache = cache
        self.defaults = defaults
        self.query = query
    }

    private let query: String

    /// Fetches the whole inbox into the cache. Returns the cached inbox view.
    @discardableResult
    func fullSync() async throws -> [WinnowEmail] {
        try await syncAllMailboxes()
        return try cache.all()
    }

    /// Full sync → all mailboxes.
    func fullSnapshot() async throws -> GmailMailboxSnapshot {
        try await syncAllMailboxes()
        return try GmailMailboxSnapshot(cache: cache)
    }

    /// Applies server-side changes since the last sync to every mailbox.
    @discardableResult
    func incrementalSync() async throws -> [WinnowEmail] {
        try await applyIncremental()
        return try cache.all()
    }

    /// Incremental sync → all mailboxes.
    func incrementalSnapshot() async throws -> GmailMailboxSnapshot {
        try await applyIncremental()
        return try GmailMailboxSnapshot(cache: cache)
    }

    // MARK: - Full sync

    private func syncAllMailboxes() async throws {
        lastSyncFailureCount = 0
        defaults.removeObject(forKey: Self.historyIDKey)
        let historyID = try await client.profile().historyId
        var seenIDs = Set<String>()
        var fetchedIDs = Set<String>()
        var hasTruncatedMailbox = false

        for (query, cap) in [
            (self.query, Int.max),
            (archiveQuery, broadMailboxCap),
            ("in:trash", broadMailboxCap),
            ("in:spam", broadMailboxCap)
        ] {
            var stubs: [GmailMessageStub] = []
            var pageToken: String?
            var collected = 0
            var pageCount = 0
            let maxPages = 200
            repeat {
                pageCount += 1
                guard pageCount <= maxPages else {
                    #if DEBUG
                    print("[gmail-sync] pagination guard: exceeded \(maxPages) pages on query \"\(query)\"")
                    #endif
                    break
                }
                let page = try await client.listMessages(
                    query: query,
                    pageToken: pageToken,
                    maxResults: min(GmailClient.maxPageSize, cap - collected)
                )
                if let messages = page.messages {
                    stubs.append(contentsOf: messages)
                    collected += messages.count
                }
                pageToken = page.nextPageToken
                if collected >= cap {
                    if pageToken != nil { hasTruncatedMailbox = true }
                    pageToken = nil
                }
            } while pageToken != nil

            var batch: [SyncItem] = []
            batch.reserveCapacity(batchSize)
            func flush() throws {
                guard !batch.isEmpty else { return }
                try cache.upsertAll(batch.map { (email: $0.email, gmailId: $0.gmailId, threadId: $0.threadId, mailbox: $0.mailbox) })
                batch.removeAll(keepingCapacity: true)
            }
            for stub in stubs where fetchedIDs.insert(stub.id).inserted {
                switch await fetch(id: stub.id, threadId: stub.threadId) {
                case .success(let item):
                    seenIDs.insert(stub.id)
                    batch.append(item)
                    if batch.count >= batchSize { try flush() }
                case .missing:
                    break
                case .failed:
                    seenIDs.insert(stub.id)
                }
            }
            try flush()
        }

        if hasTruncatedMailbox {
            for id in try cache.gmailIDs().subtracting(fetchedIDs) {
                try await refetchAndStore(id: id, threadId: nil)
                seenIDs.insert(id)
            }
        }

        // Anything in the cache that no longer exists in ANY tracked view has
        // been permanently deleted (or moved to SENT/DRAFTS/etc.) — drop it.
        try cache.keepOnly(gmailIds: seenIDs)

        if lastSyncFailureCount == 0 {
            defaults.set(historyID, forKey: Self.historyIDKey)
        }
    }

    // MARK: - Incremental sync

    private func applyIncremental() async throws {
        guard let startHistoryID = defaults.string(forKey: Self.historyIDKey) else {
            try await syncAllMailboxes()
            return
        }
        lastSyncFailureCount = 0

        do {
            var pageToken: String?
            var historyID = startHistoryID
            var pageCount = 0
            let maxPages = 200
            repeat {
                pageCount += 1
                guard pageCount <= maxPages else {
                    #if DEBUG
                    print("[gmail-sync] incremental pagination guard: exceeded \(maxPages) pages")
                    #endif
                    break
                }
                let page = try await client.historyList(startHistoryID: startHistoryID, pageToken: pageToken)
                try await apply(page.history ?? [])
                pageToken = page.nextPageToken
                historyID = page.historyId
            } while pageToken != nil
            if lastSyncFailureCount == 0 {
                defaults.set(historyID, forKey: Self.historyIDKey)
            }
        } catch GmailAPIError.http(let status, _) where status == 404 {
            // History cursor older than Google retains → full rebuild.
            try await syncAllMailboxes()
        }
    }

    /// History events are label-diffs, not full messages: the reliable way to
    /// reconcile is to re-fetch each touched message and re-derive everything
    /// (mailbox bucket, star, read state) from its fresh labels. Cheap at
    /// incremental volume, and it cannot drift from label semantics.
    private func apply(_ records: [GmailHistoryRecord]) async throws {
        var touched = Set<String>()
        for record in records {
            for deleted in record.messagesDeleted ?? [] {
                try cache.remove(gmailIds: [deleted.message.id])
            }
            for added in record.messagesAdded ?? [] { touched.insert(added.message.id) }
            for added in record.labelsAdded ?? [] { touched.insert(added.message.id) }
            for removed in record.labelsRemoved ?? [] { touched.insert(removed.message.id) }
        }
        for id in touched {
            try await refetchAndStore(id: id, threadId: nil)
        }
    }

    // MARK: - Fetch & store

    private struct SyncItem {
        let email: WinnowEmail
        let gmailId: String
        let threadId: String
        let mailbox: EmailMailbox
    }

    private enum FetchResult {
        case success(SyncItem)
        /// The message no longer exists server-side (404) — safe to drop.
        case missing
        /// Transient failure — keep whatever the cache has, just count it.
        case failed
    }

    /// Fetches one full message and derives its mailbox bucket from labels.
    private func fetch(id: String, threadId: String?) async -> FetchResult {
        do {
            let message = try await client.message(id: id)
            // Mail the user wrote (sent/drafts) is not a tracked view — drop it.
            // Spam IS tracked (the Spam mailbox), so SPAM-labeled messages are
            // homed by `mailbox(of:)` instead of being discarded.
            if !message.hasLabel(GmailLabel.inbox) && !message.hasLabel(GmailLabel.trash) && !message.hasLabel(GmailLabel.spam),
               ["SENT", "DRAFT"].contains(where: message.hasLabel) {
                return .missing
            }
            // The mapper now maps trash and spam too; bucket is decided by labels.
            guard let email = GmailMessageMapper.winnowEmail(from: message) else { return .missing }
            return .success(SyncItem(
                email: email,
                gmailId: message.id,
                threadId: message.threadId ?? threadId ?? "",
                mailbox: GmailMessageMapper.mailbox(of: message)
            ))
        } catch GmailAPIError.http(let status, _) where status == 404 {
            return .missing
        } catch {
            lastSyncFailureCount += 1
            #if DEBUG
            print("[gmail-sync] skipped message \(id): \(error)")
            #endif
            return .failed
        }
    }

    /// Re-fetches a message (incremental path) and parks it in the bucket its
    /// fresh labels imply. A message that vanished (404) leaves the cache; a
    /// transient failure keeps the stale copy rather than losing mail.
    private func refetchAndStore(id: String, threadId: String?) async throws {
        switch await fetch(id: id, threadId: threadId) {
        case .success(let item):
            try cache.upsert(
                email: item.email,
                gmailId: item.gmailId,
                threadId: item.threadId,
                mailbox: item.mailbox
            )
        case .missing:
            try cache.remove(gmailIds: [id])
        case .failed:
            break
        }
    }

}

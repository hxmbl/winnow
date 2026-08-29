import Foundation

/// Keeps the local cache aligned with the server mailbox.
///
/// LOGIC (two strategies, chosen by state)
/// - **Full sync** (first sign-in, or a `historyId` older than Google's
///   retention): page through `messages.list` with `in:inbox`, fetch each
///   message, map, upsert in batches. Trashed and non-inbox messages are
///   dropped at the mapper/fetch layer.
/// - **Incremental sync** (every refresh after that): `history.list` since the
///   stored `historyId` — only messages Google says changed are fetched or
///   removed. `historyId` is persisted in UserDefaults: it is an opaque sync
///   cursor, not a secret.
/// - If the incremental cursor is invalid (HTTP 404 — history expired), the
///   engine falls back to a full sync automatically.
@MainActor
final class GmailSyncEngine {
    private let client: GmailClient
    private let cache: EmailCacheStore
    private let defaults: UserDefaults
    private let query: String

    static let historyIDKey = "winnow.gmail.historyId"
    private let batchSize = 25

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

    /// Fetches the whole inbox into the cache. Returns the cached view.
    @discardableResult
    func fullSync() async throws -> [WinnowEmail] {
        lastSyncFailureCount = 0

        var stubs: [GmailMessageStub] = []
        var pageToken: String?
        repeat {
            let page = try await client.listMessages(query: query, pageToken: pageToken)
            stubs.append(contentsOf: page.messages ?? [])
            pageToken = page.nextPageToken
        } while pageToken != nil

        var batch: [(email: WinnowEmail, gmailId: String, threadId: String)] = []
        batch.reserveCapacity(batchSize)
        func flush() throws {
            guard !batch.isEmpty else { return }
            try cache.upsertAll(batch)
            batch.removeAll(keepingCapacity: true)
        }

        for stub in stubs {
            if let item = await fetchAndStore(id: stub.id, threadId: stub.threadId) {
                batch.append(item)
                if batch.count >= batchSize { try flush() }
            }
        }
        try flush()

        await recordHistoryID()
        return try cache.all()
    }

    /// Applies server-side changes since the last sync. Returns the cached view.
    @discardableResult
    func incrementalSync() async throws -> [WinnowEmail] {
        guard let startHistoryID = defaults.string(forKey: Self.historyIDKey) else {
            return try await fullSync()
        }
        lastSyncFailureCount = 0

        do {
            var pageToken: String?
            repeat {
                let page = try await client.historyList(startHistoryID: startHistoryID, pageToken: pageToken)
                try await apply(page.history ?? [])
                pageToken = page.nextPageToken
                defaults.set(page.historyId, forKey: Self.historyIDKey)
            } while pageToken != nil
        } catch GmailAPIError.http(let status, _) where status == 404 {
            // History cursor older than Google retains → full rebuild.
            return try await fullSync()
        }

        return try cache.all()
    }

    // MARK: - History application

    private func apply(_ records: [GmailHistoryRecord]) async throws {
        for record in records {
            for deleted in record.messagesDeleted ?? [] {
                try cache.remove(gmailIds: [deleted.message.id])
            }
            for added in record.messagesAdded ?? [] {
                let message = added.message
                if message.hasLabel(GmailLabel.trash) {
                    try cache.remove(gmailIds: [message.id])
                } else {
                    try await refetchAndStore(id: message.id, threadId: message.threadId)
                }
            }

            // Label changes carry opposite semantics per list, and INBOX is
            // the mailbox boundary: archived-elsewhere mail must leave the
            // cache, untrashed/unarchived mail must re-enter it.
            for added in record.labelsAdded ?? [] {
                guard let labels = added.message.labelIds else { continue }
                if labels.contains(GmailLabel.trash) {
                    try cache.remove(gmailIds: [added.message.id])
                } else if labels.contains(GmailLabel.inbox) {
                    try await refetchAndStore(id: added.message.id, threadId: nil)
                } else if labels.contains(GmailLabel.starred) {
                    try cache.setStarred(
                        numericId: GmailMessageMapper.stableNumericID(for: added.message.id),
                        starred: true
                    )
                }
            }
            for removed in record.labelsRemoved ?? [] {
                guard let labels = removed.message.labelIds else { continue }
                if labels.contains(GmailLabel.trash) {
                    // Out of trash: re-fetch — it re-enters only if it is in
                    // the inbox (fetchAndStore enforces that).
                    try await refetchAndStore(id: removed.message.id, threadId: nil)
                } else if labels.contains(GmailLabel.inbox) {
                    try cache.remove(gmailIds: [removed.message.id])
                } else if labels.contains(GmailLabel.starred) {
                    try cache.setStarred(
                        numericId: GmailMessageMapper.stableNumericID(for: removed.message.id),
                        starred: false
                    )
                }
            }
        }
    }

    // MARK: - Fetch & store

    /// Fetches one message through `fetchAndStore` and persists it. The
    /// incremental paths use this — `fetchAndStore` alone only *classifies*
    /// whether the message belongs in the cache.
    private func refetchAndStore(id: String, threadId: String?) async throws {
        if let stored = await fetchAndStore(id: id, threadId: threadId) {
            try cache.upsert(
                email: stored.email,
                gmailId: stored.gmailId,
                threadId: stored.threadId
            )
        }
    }

    /// Fetches one full message and stores it **only if it is in the inbox** —
    /// history events cover the whole mailbox, so without this check our own
    /// sent mail and archived mail would leak into the list. Returns the
    /// stored item (nil when skipped); 404s are skipped silently, other
    /// failures are counted in `lastSyncFailureCount` so partial syncs are
    /// visible.
    private func fetchAndStore(id: String, threadId: String?) async -> (email: WinnowEmail, gmailId: String, threadId: String)? {
        do {
            let message = try await client.message(id: id)
            guard message.hasLabel(GmailLabel.inbox), !message.hasLabel(GmailLabel.trash) else {
                try? cache.remove(gmailIds: [id])
                return nil
            }
            guard let email = GmailMessageMapper.winnowEmail(from: message) else { return nil }
            let resolvedThreadId = message.threadId ?? threadId ?? ""
            return (email, message.id, resolvedThreadId)
        } catch GmailAPIError.http(let status, _) where status == 404 {
            return nil
        } catch {
            lastSyncFailureCount += 1
            #if DEBUG
            print("[gmail-sync] skipped message \(id): \(error)")
            #endif
            return nil
        }
    }

    private func recordHistoryID() async {
        if let profile = try? await client.profile() {
            defaults.set(profile.historyId, forKey: Self.historyIDKey)
        }
    }
}

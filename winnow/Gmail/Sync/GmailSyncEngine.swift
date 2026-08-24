import Foundation

/// Keeps the local cache aligned with the server mailbox.
///
/// LOGIC (two strategies, chosen by state)
/// - **Full sync** (first sign-in, or a `historyId` older than Google's
///   retention): page through `messages.list` with `in:inbox`, fetch each
///   message, map, upsert. Sequential fetches keep the logic obvious; at
///   typical inbox sizes this is seconds, and it runs off the UI's back via
///   async/await. Trashed messages are dropped at the mapper.
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

    init(client: GmailClient, cache: EmailCacheStore, defaults: UserDefaults = .standard, query: String = "in:inbox") {
        self.client = client
        self.cache = cache
        self.defaults = defaults
        self.query = query
    }

    /// Fetches the whole inbox into the cache. Returns the cached view.
    @discardableResult
    func fullSync() async throws -> [WinnowEmail] {
        var stubs: [GmailMessageStub] = []
        var pageToken: String?
        repeat {
            let page = try await client.listMessages(query: query, pageToken: pageToken)
            stubs.append(contentsOf: page.messages ?? [])
            pageToken = page.nextPageToken
        } while pageToken != nil

        for stub in stubs {
            await fetchAndStore(id: stub.id, threadId: stub.threadId)
        }

        await recordHistoryID()
        return try cache.all()
    }

    /// Applies server-side changes since the last sync. Returns the cached view.
    @discardableResult
    func incrementalSync() async throws -> [WinnowEmail] {
        guard let startHistoryID = defaults.string(forKey: Self.historyIDKey) else {
            return try await fullSync()
        }

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
                    await fetchAndStore(id: message.id, threadId: message.threadId)
                }
            }
            // Label changes: the two lists carry opposite semantics. For
            // `labelsAdded`, STARRED in the list means "now starred"; for
            // `labelsRemoved`, STARRED in the list means "now NOT starred".
            // Merging the loops would invert every unstar event.
            for added in record.labelsAdded ?? [] {
                guard let labelIds = added.message.labelIds else { continue }
                try cache.setStarred(
                    numericId: GmailMessageMapper.stableNumericID(for: added.message.id),
                    starred: labelIds.contains(GmailLabel.starred)
                )
            }
            for removed in record.labelsRemoved ?? [] {
                guard let labelIds = removed.message.labelIds, labelIds.contains(GmailLabel.starred) else { continue }
                try cache.setStarred(
                    numericId: GmailMessageMapper.stableNumericID(for: removed.message.id),
                    starred: false
                )
            }
        }
    }

    // MARK: - Fetch & store

    /// Fetches one full message; 404s (deleted between list and get) are
    /// skipped rather than failing the whole sync.
    private func fetchAndStore(id: String, threadId: String?) async {
        do {
            let message = try await client.message(id: id)
            guard let email = GmailMessageMapper.winnowEmail(from: message) else { return }
            try cache.upsert(
                email: email,
                gmailId: message.id,
                threadId: message.threadId ?? threadId ?? ""
            )
        } catch GmailAPIError.http(let status, _) where status == 404 {
            return
        } catch {
            // One bad message shouldn't abort the sync of the rest; the next
            // incremental pass will retry it via history.
            #if DEBUG
            print("[gmail-sync] skipped message \(id): \(error)")
            #endif
        }
    }

    private func recordHistoryID() async {
        if let profile = try? await client.profile() {
            defaults.set(profile.historyId, forKey: Self.historyIDKey)
        }
    }
}

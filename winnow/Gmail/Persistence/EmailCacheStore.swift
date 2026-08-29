import Foundation
import SwiftData

/// On-disk cache of one Gmail message.
///
/// SECURITY MODEL / LOGIC
/// - This is the **only** place email content touches disk, and it lives in
///   the app's sandboxed container — nothing is written outside it.
/// - Keyed by `gmailId` (`.unique`): every API round-trip (star, trash, reply)
///   uses this real id. `numericId` is the UI key derived in the mapper and
///   is deliberately *not* unique-constrained — the string id is authoritative.
/// - Wiped on sign-out (`EmailCacheStore.wipe()`): signing out of Winnow means
///   no local copy of your mail survives.
@Model
final class StoredEmail {
    @Attribute(.unique) var gmailId: String
    var threadId: String
    var numericId: Int
    var sender: String
    var name: String?
    var address: String?
    var receivedAt: Int
    var subject: String
    var body: String
    var type: String
    var starred: Bool

    init(gmailId: String, threadId: String, email: WinnowEmail) {
        self.gmailId = gmailId
        self.threadId = threadId
        self.numericId = email.id
        self.sender = email.sender
        self.name = email.name
        self.address = email.email
        self.receivedAt = email.receivedAt
        self.subject = email.subject
        self.body = email.body
        self.type = email.type
        self.starred = email.starred
    }

    var winnowEmail: WinnowEmail {
        WinnowEmail(
            id: numericId,
            sender: sender,
            name: name,
            email: address,
            receivedAt: receivedAt,
            subject: subject,
            body: body,
            type: type,
            starred: starred,
            urgent: false
        )
    }
}

/// MainActor wrapper around the SwiftData container. One context, explicit
/// saves — no autosave surprises.
@MainActor
final class EmailCacheStore {
    private let container: ModelContainer
    private let context: ModelContext

    /// `inMemory` for tests/previews; production uses the default store in
    /// Application Support.
    init(inMemory: Bool = false) throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: inMemory)
        container = try ModelContainer(for: StoredEmail.self, configurations: configuration)
        context = ModelContext(container)
        context.autosaveEnabled = false
    }

    func upsert(email: WinnowEmail, gmailId: String, threadId: String) throws {
        try upsertAll([(email: email, gmailId: gmailId, threadId: threadId)])
    }

    /// Batch upsert: one fetch, one save — a full sync does N/25 round-trips
    /// instead of 2N.
    func upsertAll(_ items: [(email: WinnowEmail, gmailId: String, threadId: String)]) throws {
        guard !items.isEmpty else { return }
        let ids = items.map(\.gmailId)
        let predicate = #Predicate<StoredEmail> { ids.contains($0.gmailId) }
        let existing = try context.fetch(FetchDescriptor(predicate: predicate))
        let byGmailId = Dictionary(uniqueKeysWithValues: existing.map { ($0.gmailId, $0) })

        for item in items {
            if let stored = byGmailId[item.gmailId] {
                stored.threadId = item.threadId
                stored.sender = item.email.sender
                stored.name = item.email.name
                stored.address = item.email.email
                stored.receivedAt = item.email.receivedAt
                stored.subject = item.email.subject
                stored.body = item.email.body
                stored.type = item.email.type
                stored.starred = item.email.starred
                stored.numericId = item.email.id
            } else {
                context.insert(StoredEmail(gmailId: item.gmailId, threadId: item.threadId, email: item.email))
            }
        }
        try context.save()
    }

    /// Cached inbox, newest first.
    func all() throws -> [WinnowEmail] {
        let descriptor = FetchDescriptor<StoredEmail>(sortBy: [SortDescriptor(\.receivedAt, order: .reverse)])
        return try context.fetch(descriptor).map(\.winnowEmail)
    }

    /// The real Gmail id for a UI-level numeric id — the bridge actions need.
    func gmailID(for numericId: Int) -> String? {
        let predicate = #Predicate<StoredEmail> { $0.numericId == numericId }
        return try? context.fetch(FetchDescriptor(predicate: predicate)).first?.gmailId
    }

    /// `Message-ID` of the cached message, for reply threading headers.
    /// (Stored only when known; nil otherwise.)
    func threadID(for numericId: Int) -> String? {
        let predicate = #Predicate<StoredEmail> { $0.numericId == numericId }
        return try? context.fetch(FetchDescriptor(predicate: predicate)).first?.threadId
    }

    func setStarred(numericId: Int, starred: Bool) throws {
        let predicate = #Predicate<StoredEmail> { $0.numericId == numericId }
        guard let stored = try context.fetch(FetchDescriptor(predicate: predicate)).first else { return }
        stored.starred = starred
        try context.save()
    }

    func remove(gmailIds: [String]) throws {
        for gmailId in gmailIds {
            let predicate = #Predicate<StoredEmail> { $0.gmailId == gmailId }
            for stored in try context.fetch(FetchDescriptor(predicate: predicate)) {
                context.delete(stored)
            }
        }
        try context.save()
    }

    func wipe() throws {
        try context.delete(model: StoredEmail.self)
        try context.save()
    }

    var count: Int { (try? context.fetchCount(FetchDescriptor<StoredEmail>())) ?? 0 }
}

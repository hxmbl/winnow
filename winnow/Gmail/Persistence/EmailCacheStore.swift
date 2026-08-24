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
        let predicate = #Predicate<StoredEmail> { $0.gmailId == gmailId }
        if let existing = try context.fetch(FetchDescriptor(predicate: predicate)).first {
            existing.threadId = threadId
            existing.sender = email.sender
            existing.name = email.name
            existing.address = email.email
            existing.receivedAt = email.receivedAt
            existing.subject = email.subject
            existing.body = email.body
            existing.type = email.type
            existing.starred = email.starred
            existing.numericId = email.id
        } else {
            context.insert(StoredEmail(gmailId: gmailId, threadId: threadId, email: email))
        }
        try context.save()
    }

    func upsertAll(_ items: [(email: WinnowEmail, gmailId: String, threadId: String)]) throws {
        for item in items { try upsert(email: item.email, gmailId: item.gmailId, threadId: item.threadId) }
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

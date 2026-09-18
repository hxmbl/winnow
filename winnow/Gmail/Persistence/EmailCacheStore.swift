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
    var unread: Bool = false
    /// Which mailbox bucket this message belongs to (`EmailMailbox.rawValue`).
    var mailbox: String = EmailMailbox.inbox.rawValue
    var bodyHTML: String?
    /// JSON-encoded `[EmailAttachment]` — metadata only, payloads stay remote.
    var attachmentsJSON: String?

    init(gmailId: String, threadId: String, email: WinnowEmail, mailbox: EmailMailbox) {
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
        self.unread = email.unread
        self.mailbox = mailbox.rawValue
        self.bodyHTML = email.bodyHTML
        self.attachmentsJSON = Self.encodeAttachments(email.attachments)
    }

    var winnowEmail: WinnowEmail {
        WinnowEmail(
            id: numericId,
            threadId: threadId.isEmpty ? nil : threadId,
            sender: sender,
            name: name,
            email: address,
            receivedAt: receivedAt,
            subject: subject,
            body: body,
            type: type,
            starred: starred,
            urgent: false,
            unread: unread,
            bodyHTML: bodyHTML,
            attachments: Self.decodeAttachments(attachmentsJSON)
        )
    }

    nonisolated static func encodeAttachments(_ list: [EmailAttachment]) -> String? {
        guard !list.isEmpty else { return nil }
        return (try? JSONEncoder().encode(list)).map { String(decoding: $0, as: UTF8.self) }
    }

    nonisolated static func decodeAttachments(_ json: String?) -> [EmailAttachment] {
        guard let json, let data = json.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([EmailAttachment].self, from: data)) ?? []
    }
}

/// MainActor wrapper around the SwiftData container. One context, explicit
/// saves — no autosave surprises.
@MainActor
final class EmailCacheStore {
    private let container: ModelContainer
    private let context: ModelContext

    /// `inMemory` for tests/previews; production uses the default store in
    /// Application Support. Pass `url` to place the store elsewhere (tests).
    ///
    /// A store written by an older schema — or one corrupted on disk — cannot
    /// always be loaded by the current model: SwiftData reports that as
    /// `SwiftDataError._Error.loadIssueModelContainer`. Since this is a
    /// disposable cache (rebuilt from the server on the next sync), a load
    /// failure purges the stale files and starts clean instead of wedging the
    /// app on the login screen.
    init(inMemory: Bool = false, url: URL? = nil) throws {
        let configuration: ModelConfiguration
        if inMemory {
            configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        } else {
            configuration = ModelConfiguration(url: url ?? Self.defaultStoreURL())
        }
        container = try Self.loadContainer(configuration)
        context = ModelContext(container)
        context.autosaveEnabled = false
    }

    /// The location SwiftData uses for the default on-disk container:
    /// `Application Support/default.store` inside the app's sandboxed container.
    private static func defaultStoreURL() -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("default.store")
    }

    /// Creates the container, recovering from a stale or corrupt store: the
    /// failed file is removed (with its SQLite WAL/SHM sidecars) and a fresh
    /// empty store is created in its place.
    ///
    /// Only schema/load errors trigger a purge — transient failures like disk-full
    /// or file locks are surfaced to the caller so the sync engine can retry.
    private static func loadContainer(_ configuration: ModelConfiguration) throws -> ModelContainer {
        do {
            return try ModelContainer(for: StoredEmail.self, configurations: configuration)
        } catch {
            // In-memory containers own no store file — if one ever fails there
            // is nothing to purge, so surface the error.
            guard !configuration.isStoredInMemoryOnly else { throw error }

            let nsError = error as NSError
            // Only purge on schema mismatch or corrupt-store errors — NOT on
            // disk-full (NSPOSIXErrorDomain code 28), permissions (code 13),
            // or file-locked (EBUSY) conditions where the files are still valid.
            let isSchemaError = nsError.domain.contains("SwiftData")
                || nsError.domain.contains("CoreData")
                || nsError.code == 134100   // Core Data model incompatibility
                || nsError.code == 134110   // persistent store store-level error
                || nsError.code == 134130   // migration error
            guard isSchemaError else { throw error }

            #if DEBUG
            print("[email-cache] purging stale store: \(error)")
            #endif
            purgeStoreFiles(at: configuration.url)
            return try ModelContainer(for: StoredEmail.self, configurations: configuration)
        }
    }

    private static func purgeStoreFiles(at url: URL) {
        // A SwiftData store is a SQLite database with WAL/SHM sidecars.
        for path in [url.path, url.path + "-wal", url.path + "-shm"] {
            try? FileManager.default.removeItem(atPath: path)
        }
    }

    func upsert(email: WinnowEmail, gmailId: String, threadId: String, mailbox: EmailMailbox = .inbox) throws {
        try upsertAll([(email: email, gmailId: gmailId, threadId: threadId, mailbox: mailbox)])
    }

    /// Batch upsert: one fetch, one save — a full sync does N/25 round-trips
    /// instead of 2N. `mailbox` moves the message between buckets when it
    /// changes (e.g. an archive arrives as a mailbox flip).
    func upsertAll(_ items: [(email: WinnowEmail, gmailId: String, threadId: String, mailbox: EmailMailbox)]) throws {
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
                stored.unread = item.email.unread
                stored.mailbox = item.mailbox.rawValue
                stored.bodyHTML = item.email.bodyHTML
                stored.attachmentsJSON = StoredEmail.encodeAttachments(item.email.attachments)
                stored.numericId = item.email.id
            } else {
                context.insert(StoredEmail(gmailId: item.gmailId, threadId: item.threadId, email: item.email, mailbox: item.mailbox))
            }
        }
        try context.save()
    }

    /// Cached mail for one mailbox, newest first.
    func all(mailbox: EmailMailbox) throws -> [WinnowEmail] {
        let mailboxRaw = mailbox.rawValue
        let descriptor = FetchDescriptor<StoredEmail>(
            predicate: #Predicate { $0.mailbox == mailboxRaw },
            sortBy: [SortDescriptor(\.receivedAt, order: .reverse)]
        )
        return try context.fetch(descriptor).map(\.winnowEmail)
    }

    /// Cached inbox, newest first (backwards-compatible convenience — the
    /// inbox is the mailbox that has always been stored here).
    func all() throws -> [WinnowEmail] {
        try all(mailbox: .inbox)
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

    func setUnread(numericId: Int, unread: Bool) throws {
        let predicate = #Predicate<StoredEmail> { $0.numericId == numericId }
        guard let stored = try context.fetch(FetchDescriptor(predicate: predicate)).first else { return }
        stored.unread = unread
        try context.save()
    }

    /// Moves a message between mailbox buckets (archive ⇄ inbox ⇄ trash).
    func setMailbox(numericId: Int, mailbox: EmailMailbox) throws {
        let predicate = #Predicate<StoredEmail> { $0.numericId == numericId }
        guard let stored = try context.fetch(FetchDescriptor(predicate: predicate)).first else { return }
        stored.mailbox = mailbox.rawValue
        try context.save()
    }

    /// Attachment metadata for a message, if any.
    func attachments(numericId: Int) -> [EmailAttachment] {
        let predicate = #Predicate<StoredEmail> { $0.numericId == numericId }
        guard let stored = try? context.fetch(FetchDescriptor(predicate: predicate)).first else { return [] }
        return StoredEmail.decodeAttachments(stored.attachmentsJSON)
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

    func gmailIDs() throws -> Set<String> {
        Set(try context.fetch(FetchDescriptor<StoredEmail>()).map(\.gmailId))
    }

    /// Deletes every cached message whose gmail id is absent from the set —
    /// permanent deletions / moves out of tracked views surface this way.
    func keepOnly(gmailIds: Set<String>) throws {
        let all = try context.fetch(FetchDescriptor<StoredEmail>())
        var changed = false
        for stored in all where !gmailIds.contains(stored.gmailId) {
            context.delete(stored)
            changed = true
        }
        if changed { try context.save() }
    }

    func wipe() throws {
        try context.delete(model: StoredEmail.self)
        try context.save()
    }

    var count: Int { (try? context.fetchCount(FetchDescriptor<StoredEmail>())) ?? 0 }
}

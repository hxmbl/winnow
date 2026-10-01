import Foundation
import Testing
@testable import winnow

@MainActor
struct GmailSyncTests {

    private func makeStack(defaults: UserDefaults) throws -> (GmailClient, EmailCacheStore, GmailSyncEngine, TokenManager) {
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
        let sync = GmailSyncEngine(client: client, cache: cache, defaults: defaults)
        return (client, cache, sync, manager)
    }

    @Test func staleOrCorruptStoreIsPurgedAndRebuiltOnLoad() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("winnow-store-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let storeURL = dir.appendingPathComponent("cache.store")

        // A store written by an older schema — or any non-SwiftData file —
        // can't be loaded by the current model. The cache must recover by
        // purging the stale files and rebuilding, not wedging the app.
        try Data("stale store".utf8).write(to: storeURL)
        try Data("stale wal".utf8).write(to: URL(fileURLWithPath: storeURL.path + "-wal"))

        let cache = try EmailCacheStore(url: storeURL)
        #expect(cache.isEmpty)                       // recreated empty, not wedged
        try cache.upsert(email: Fixtures.email(id: 1), gmailId: "g1", threadId: "t", mailbox: .inbox)
        #expect(cache.count == 1)                       // and fully usable again
    }

    private func fullMessageJSON(id: String, subject: String, starred: Bool = false) -> String {
        """
        {
          "id": "\(id)", "threadId": "t-\(id)",
          "labelIds": ["INBOX"\(starred ? ", \"STARRED\"" : "")],
          "internalDate": "1778371140000",
          "payload": {
            "mimeType": "text/plain",
            "headers": [
              {"name": "From", "value": "Ada <ada@example.com>"},
              {"name": "Subject", "value": "\(subject)"}
            ],
            "body": {"data": "\(Base64URL.encode(Data("Body of \(subject)".utf8)))"}
          }
        }
        """
    }

    @Test func fullSyncPopulatesTheCacheAndRecordsHistoryID() async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }

            StubURLProtocol.route { request in
                switch (request.url?.path ?? "", request.url?.query?.contains("q=in") ?? false) {
                case (let path, _) where path.hasSuffix("/messages") && request.httpMethod == "GET":
                    return (200, Data(#"{"messages":[{"id":"m1","threadId":"t1"},{"id":"m2","threadId":"t2"}],"resultSizeEstimate":2}"#.utf8))
                case (let path, _) where path.contains("/messages/m1"):
                    return (200, Data(self.fullMessageJSON(id: "m1", subject: "First").utf8))
                case (let path, _) where path.contains("/messages/m2"):
                    return (200, Data(self.fullMessageJSON(id: "m2", subject: "Second", starred: true).utf8))
                case (let path, _) where path.hasSuffix("/profile"):
                    return (200, Data(#"{"emailAddress":"ada@example.com","historyId":"777"}"#.utf8))
                default:
                    return (404, Data())
                }
            }

            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            let emails = try await sync.fullSync()

            #expect(emails.count == 2)
            #expect(cache.count == 2)
            #expect(Set(emails.map(\.subject)) == ["First", "Second"])
            #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == "777")
        }
    }

    @Test func incrementalSyncAppliesLabelChangesAndDeletions() async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }

            StubURLProtocol.route { request in
                let path = request.url?.path ?? ""
                if path.hasSuffix("/history") {
                    let json = """
                    {"history":[{"id":"h1","labelsAdded":[{"message":{"id":"m1","labelIds":["STARRED"]}}],"messagesDeleted":[{"message":{"id":"m2","threadId":"t2"}}]}],"historyId":"888"}
                    """
                    return (200, Data(json.utf8))
                }
                if path.contains("/messages/m1") {
                    return (200, Data(self.fullMessageJSON(id: "m1", subject: "First", starred: true).utf8))
                }
                if path.hasSuffix("/profile") {
                    return (200, Data(#"{"emailAddress":"a@b.c","historyId":"888"}"#.utf8))
                }
                return (404, Data())
            }

            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            // Production stores mapper-derived numeric ids; mirror that here
            // so the label change targets the same key the cache uses.
            try cache.upsert(
                email: Fixtures.email(id: GmailMessageMapper.stableNumericID(for: "m1"), subject: "First"),
                gmailId: "m1",
                threadId: "t1"
            )
            try cache.upsert(
                email: Fixtures.email(id: GmailMessageMapper.stableNumericID(for: "m2"), subject: "Second"),
                gmailId: "m2",
                threadId: "t2"
            )
            defaults.set("777", forKey: GmailSyncEngine.historyIDKey)

            let emails = try await sync.incrementalSync()

            #expect(cache.count == 1)
            #expect(emails.first?.subject == "First")
            #expect(emails.first?.starred == true)
            #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == "888")
        }
    }

    @Test func incrementalSyncAppliesUnstarFromLabelsRemoved() async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }

            StubURLProtocol.route { request in
                let path = request.url?.path ?? ""
                if path.hasSuffix("/history") {
                    let json = """
                    {"history":[{"id":"h1","labelsRemoved":[{"message":{"id":"m1","labelIds":["STARRED"]}}]}],"historyId":"889"}
                    """
                    return (200, Data(json.utf8))
                }
                if path.contains("/messages/m1") {
                    return (200, Data(self.fullMessageJSON(id: "m1", subject: "First").utf8))
                }
                if path.hasSuffix("/profile") {
                    return (200, Data(#"{"emailAddress":"a@b.c","historyId":"889"}"#.utf8))
                }
                return (404, Data())
            }

            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            let numericID = GmailMessageMapper.stableNumericID(for: "m1")
            try cache.upsert(
                email: Fixtures.email(id: numericID, subject: "First", starred: true),
                gmailId: "m1",
                threadId: "t1"
            )
            defaults.set("888", forKey: GmailSyncEngine.historyIDKey)

            let emails = try await sync.incrementalSync()

            // The regression: labelsRemoved carrying STARRED must clear the
            // star, not set it.
            #expect(emails.first?.starred == false)
            #expect(try cache.all().first?.starred == false)
            _ = numericID
        }
    }

    @Test func expiredHistoryCursorFallsBackToFullSync() async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            defaults.set("ancient", forKey: GmailSyncEngine.historyIDKey)

            StubURLProtocol.route { request in
                let path = request.url?.path ?? ""
                if path.hasSuffix("/history") { return (404, Data()) }
                if path.hasSuffix("/messages") && request.httpMethod == "GET" {
                    return (200, Data(#"{"messages":[{"id":"m9","threadId":"t9"}]}"#.utf8))
                }
                if path.contains("/messages/m9") {
                    return (200, Data(self.fullMessageJSON(id: "m9", subject: "Refetched").utf8))
                }
                if path.hasSuffix("/profile") {
                    return (200, Data(#"{"emailAddress":"a@b.c","historyId":"900"}"#.utf8))
                }
                return (404, Data())
            }

            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            let emails = try await sync.incrementalSync()

            #expect(emails.map(\.subject) == ["Refetched"])
            #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == "900")
        }
    }

    @Test func remoteArchiveViaLabelsRemovedInboxMovesTheRowToArchive() async throws {
        // Archiving from Gmail web/phone arrives as `labelsRemoved` carrying
        // INBOX. The message is re-fetched and re-homed into the archive
        // bucket (it leaves the inbox view but stays in the cache).
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }

            let archivedJSON = """
            {
              "id": "m1", "threadId": "t1",
              "labelIds": [],
              "internalDate": "1778371140000",
              "payload": {
                "mimeType": "text/plain",
                "headers": [
                  {"name": "From", "value": "Ada <ada@example.com>"},
                  {"name": "Subject", "value": "First"}
                ],
                "body": {"data": "\(Base64URL.encode(Data("Body of First".utf8)))"}
              }
            }
            """

            StubURLProtocol.route { request in
                let path = request.url?.path ?? ""
                if path.hasSuffix("/history") {
                    let json = """
                    {"history":[{"id":"h1","labelsRemoved":[{"message":{"id":"m1","threadId":"t1","labelIds":["INBOX"]}}]}],"historyId":"890"}
                    """
                    return (200, Data(json.utf8))
                }
                if path.contains("/messages/m1") {
                    return (200, Data(archivedJSON.utf8))
                }
                if path.hasSuffix("/profile") {
                    return (200, Data(#"{"emailAddress":"a@b.c","historyId":"890"}"#.utf8))
                }
                return (404, Data())
            }

            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            try cache.upsert(
                email: Fixtures.email(id: GmailMessageMapper.stableNumericID(for: "m1"), subject: "First"),
                gmailId: "m1",
                threadId: "t1"
            )
            defaults.set("889", forKey: GmailSyncEngine.historyIDKey)

            let emails = try await sync.incrementalSync()

            // Out of the inbox view…
            #expect(emails.isEmpty)
            // …but not lost: it moved to the archive bucket.
            #expect(try cache.all(mailbox: .archive).map(\.subject) == ["First"])
            #expect(cache.count == 1)
        }
    }

    @Test func remoteUnarchiveViaLabelsAddedInboxRefetchesTheMessage() async throws {
        // The mirror case: unarchiving elsewhere re-adds INBOX — the message
        // must come back through a fetch, not stay invisible until a full sync.
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }

            StubURLProtocol.route { request in
                let path = request.url?.path ?? ""
                if path.hasSuffix("/history") {
                    let json = """
                    {"history":[{"id":"h1","labelsAdded":[{"message":{"id":"m7","threadId":"t7","labelIds":["INBOX"]}}]}],"historyId":"891"}
                    """
                    return (200, Data(json.utf8))
                }
                if path.contains("/messages/m7") {
                    return (200, Data(self.fullMessageJSON(id: "m7", subject: "Back again").utf8))
                }
                if path.hasSuffix("/profile") {
                    return (200, Data(#"{"emailAddress":"a@b.c","historyId":"891"}"#.utf8))
                }
                return (404, Data())
            }

            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            defaults.set("890", forKey: GmailSyncEngine.historyIDKey)

            let emails = try await sync.incrementalSync()

            #expect(emails.map(\.subject) == ["Back again"])
            #expect(cache.count == 1)
        }
    }

    @Test func fullSyncFollowsNextPageTokensAcrossPages() async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }

            StubURLProtocol.route { request in
                let path = request.url?.path ?? ""
                let query = request.url?.query ?? ""
                if path.hasSuffix("/messages") && request.httpMethod == "GET" {
                    if query.contains("pageToken=p2") {
                        return (200, Data(#"{"messages":[{"id":"m3","threadId":"t3"}],"resultSizeEstimate":1}"#.utf8))
                    }
                    return (200, Data(#"{"messages":[{"id":"m1","threadId":"t1"},{"id":"m2","threadId":"t2"}],"nextPageToken":"p2","resultSizeEstimate":3}"#.utf8))
                }
                if path.contains("/messages/m1") {
                    return (200, Data(self.fullMessageJSON(id: "m1", subject: "First").utf8))
                }
                if path.contains("/messages/m2") {
                    return (200, Data(self.fullMessageJSON(id: "m2", subject: "Second").utf8))
                }
                if path.contains("/messages/m3") {
                    return (200, Data(self.fullMessageJSON(id: "m3", subject: "Third").utf8))
                }
                if path.hasSuffix("/profile") {
                    return (200, Data(#"{"emailAddress":"ada@example.com","historyId":"777"}"#.utf8))
                }
                return (404, Data())
            }

            let (_, _, sync, _) = try makeStack(defaults: defaults)
            let emails = try await sync.fullSync()

            #expect(emails.count == 3)
            #expect(Set(emails.map(\.subject)) == ["First", "Second", "Third"])
            #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == "777")
        }
    }

    @Test func incrementalPaginationFailureRetainsCursorAndReplaysEarlierPages() async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            defaults.set("100", forKey: GmailSyncEngine.historyIDKey)
            let (_, cache, sync, _) = try makeStack(defaults: defaults)

            for fails in [true, false] {
                StubURLProtocol.route { request in
                    let path = request.url?.path ?? ""
                    if path.hasSuffix("/history") {
                        if request.url?.query?.contains("pageToken=p2") == true {
                            return fails
                                ? (503, Data())
                                : (200, Data(#"{"history":[{"messagesAdded":[{"message":{"id":"m2"}}]}],"historyId":"300"}"#.utf8))
                        }
                        return (200, Data(#"{"history":[{"messagesAdded":[{"message":{"id":"m1"}}]}],"historyId":"200","nextPageToken":"p2"}"#.utf8))
                    }
                    let id = request.url!.lastPathComponent
                    return (200, Data(self.fullMessageJSON(id: id, subject: id).utf8))
                }

                do {
                    try await sync.incrementalSync()
                    #expect(!fails)
                } catch {
                    #expect(fails)
                    #expect(error as? GmailAPIError == .http(status: 503, bodySnippet: ""))
                }
                #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == (fails ? "100" : "300"))
                let requests = StubURLProtocol.requests.filter { $0.url?.path.hasSuffix("/history") == true }
                #expect(requests.count == 2)
                #expect(requests.allSatisfy { $0.url?.query?.contains("startHistoryId=100") == true })
            }
            #expect(Set(try cache.all().map(\.subject)) == ["m1", "m2"])
        }
    }

    @Test func incrementalFailedFetchKeepsCachedMailAndRetriesWithoutAdvancingCursor() async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            defaults.set("100", forKey: GmailSyncEngine.historyIDKey)
            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            try cache.upsert(email: Fixtures.email(id: 1, subject: "Old"), gmailId: "m1", threadId: "t1")

            for fails in [true, false] {
                StubURLProtocol.route { request in
                    if request.url?.path.hasSuffix("/history") == true {
                        return (200, Data(#"{"history":[{"labelsAdded":[{"message":{"id":"m1"}}]}],"historyId":"200"}"#.utf8))
                    }
                    return fails
                        ? (503, Data())
                        : (200, Data(self.fullMessageJSON(id: "m1", subject: "New", starred: true).utf8))
                }
                let emails = try await sync.incrementalSync()
                #expect(emails.map(\.subject) == [fails ? "Old" : "New"])
                #expect(sync.lastSyncFailureCount == (fails ? 1 : 0))
                #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == (fails ? "100" : "200"))
            }
        }
    }

    @Test func fullSyncCapturesCursorBeforeListingAndReplaysChangesDuringScan() async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            StubURLProtocol.route { request in
                let path = request.url?.path ?? ""
                if path.hasSuffix("/profile") {
                    let historyID = StubURLProtocol.requestCount(to: "/messages") == 0 ? "100" : "200"
                    return (200, Data("{\"emailAddress\":\"a@b.c\",\"historyId\":\"\(historyID)\"}".utf8))
                }
                if path.hasSuffix("/messages") { return (200, Data(#"{}"#.utf8)) }
                if path.hasSuffix("/history") {
                    if request.url?.query?.contains("startHistoryId=100") == true {
                        return (200, Data(#"{"history":[{"messagesAdded":[{"message":{"id":"m1"}}]}],"historyId":"200"}"#.utf8))
                    }
                    return (200, Data(#"{"historyId":"200"}"#.utf8))
                }
                return (200, Data(self.fullMessageJSON(id: "m1", subject: "Arrived during scan").utf8))
            }
            let (_, _, sync, _) = try makeStack(defaults: defaults)
            #expect(try await sync.fullSync().isEmpty)
            #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == "100")
            #expect(StubURLProtocol.requests.first?.url?.path.hasSuffix("/profile") == true)
            #expect(try await sync.incrementalSync().map(\.subject) == ["Arrived during scan"])
        }
    }

    @Test func incompleteFullSyncInvalidatesOldCursorAndRetriesMissingDownloads() async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            defaults.set("50", forKey: GmailSyncEngine.historyIDKey)
            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            try cache.upsert(email: Fixtures.email(id: 1, subject: "Old"), gmailId: "m1", threadId: "t1")
            for fails in [true, false] {
                StubURLProtocol.route { request in
                    let path = request.url?.path ?? ""
                    if path.hasSuffix("/profile") {
                        return (200, Data(#"{"emailAddress":"a@b.c","historyId":"100"}"#.utf8))
                    }
                    if path.hasSuffix("/messages") {
                        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "q" }?.value
                        return (200, Data((query == "in:inbox" ? #"{"messages":[{"id":"m1","threadId":"t1"},{"id":"m2","threadId":"t2"}]}"# : "{}").utf8))
                    }
                    let id = request.url!.lastPathComponent
                    return fails ? (503, Data()) : (200, Data(self.fullMessageJSON(id: id, subject: id).utf8))
                }
                if fails {
                    #expect(try await sync.fullSync().map(\.subject) == ["Old"])
                    #expect(sync.lastSyncFailureCount == 2)
                    #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == nil)
                } else {
                    #expect(Set(try await sync.incrementalSync().map(\.subject)) == ["m1", "m2"])
                    #expect(StubURLProtocol.requestCount(to: "/history") == 0)
                    #expect(sync.lastSyncFailureCount == 0)
                    #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == "100")
                }
            }
        }
    }

    @Test(arguments: ["profile", "messages"])
    func fullSyncEndpointFailureDoesNotPruneCacheOrLeaveUsableCursor(endpoint: String) async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            defaults.set("50", forKey: GmailSyncEngine.historyIDKey)
            StubURLProtocol.route { request in
                if request.url?.path.hasSuffix("/\(endpoint)") == true { return (503, Data()) }
                return (200, Data(#"{"emailAddress":"a@b.c","historyId":"100"}"#.utf8))
            }
            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            try cache.upsert(email: Fixtures.email(id: 1), gmailId: "m1", threadId: "t1")
            do {
                try await sync.fullSync()
                Issue.record("Expected full sync to fail")
            } catch {
                #expect(error as? GmailAPIError == .http(status: 503, bodySnippet: ""))
            }
            #expect(cache.count == 1)
            #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == nil)
        }
    }

    @Test(arguments: [true, false])
    func missingFetchedMessageIsRemovedFromCache(full: Bool) async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            defaults.set("50", forKey: GmailSyncEngine.historyIDKey)
            StubURLProtocol.route { request in
                let path = request.url?.path ?? ""
                if path.hasSuffix("/profile") {
                    return (200, Data(#"{"emailAddress":"a@b.c","historyId":"100"}"#.utf8))
                }
                if path.hasSuffix("/messages") {
                    return (200, Data(#"{"messages":[{"id":"m1","threadId":"t1"}]}"#.utf8))
                }
                if path.hasSuffix("/history") {
                    return (200, Data(#"{"history":[{"labelsRemoved":[{"message":{"id":"m1"}}]}],"historyId":"100"}"#.utf8))
                }
                return (404, Data())
            }
            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            try cache.upsert(email: Fixtures.email(id: 1), gmailId: "m1", threadId: "t1")
            if full { try await sync.fullSync() } else { try await sync.incrementalSync() }
            #expect(cache.isEmpty)
            #expect(sync.lastSyncFailureCount == 0)
            #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == "100")
        }
    }

    @Test func emptyFullSyncPrunesEveryMailboxAndEmptyHistoryAdvancesCursor() async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            StubURLProtocol.route { request in
                let path = request.url?.path ?? ""
                if path.hasSuffix("/profile") {
                    return (200, Data(#"{"emailAddress":"a@b.c","historyId":"100"}"#.utf8))
                }
                if path.hasSuffix("/history") { return (200, Data(#"{"historyId":"200"}"#.utf8)) }
                return (200, Data(#"{}"#.utf8))
            }
            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            for (index, mailbox) in [EmailMailbox.inbox, .archive, .trash].enumerated() {
                try cache.upsert(email: Fixtures.email(id: index), gmailId: "m\(index)", threadId: "t", mailbox: mailbox)
            }
            let snapshot = try await sync.fullSnapshot()
            #expect(snapshot.inbox.isEmpty && snapshot.archive.isEmpty && snapshot.trash.isEmpty && snapshot.spam.isEmpty)
            #expect(cache.isEmpty)
            try await sync.incrementalSync()
            #expect(defaults.string(forKey: GmailSyncEngine.historyIDKey) == "200")
        }
    }

    @Test func fullSyncMapsSpamIntoTheSnapshotAndDropsSentMail() async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }

            let spamJSON = """
            {
              "id": "s1", "threadId": "ts1",
              "labelIds": ["SPAM"],
              "internalDate": "1778371140000",
              "payload": {
                "mimeType": "text/plain",
                "headers": [
                  {"name": "From", "value": "Neferites <no-reply@lottery.example>"},
                  {"name": "Subject", "value": "Quarantined"}
                ],
                "body": {"data": "\(Base64URL.encode(Data("You have won".utf8)))"}
              }
            }
            """
            let sentJSON = """
            {
              "id": "s2", "threadId": "ts2",
              "labelIds": ["SENT"],
              "internalDate": "1778371140000",
              "payload": {
                "mimeType": "text/plain",
                "headers": [
                  {"name": "From", "value": "Me <me@example.com>"},
                  {"name": "Subject", "value": "I sent this"}
                ],
                "body": {"data": "\(Base64URL.encode(Data("My own mail".utf8)))"}
              }
            }
            """

            StubURLProtocol.route { request in
                let path = request.url?.path ?? ""
                if path.hasSuffix("/profile") {
                    return (200, Data(#"{"emailAddress":"me@example.com","historyId":"100"}"#.utf8))
                }
                if path.hasSuffix("/messages/s1") { return (200, Data(spamJSON.utf8)) }
                if path.hasSuffix("/messages/s2") { return (200, Data(sentJSON.utf8)) }
                if path.hasSuffix("/messages") && request.httpMethod == "GET" {
                    return (200, Data(#"{"messages":[{"id":"s1","threadId":"ts1"},{"id":"s2","threadId":"ts2"}]}"#.utf8))
                }
                return (404, Data())
            }

            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            let snapshot = try await sync.fullSnapshot()

            // SPAM-homed mail lands in the snapshot's spam bucket…
            #expect(snapshot.spam.map(\.subject) == ["Quarantined"])
            #expect(snapshot.spam.first?.threadId == "ts1")
            // …and the inbox bucket does not see it.
            #expect(snapshot.inbox.isEmpty)
            // Sent mail is not a tracked view: it stays out of the cache entirely.
            #expect(cache.count == 1)
            #expect(try cache.all(mailbox: .spam).map(\.subject) == ["Quarantined"])
        }
    }

    @Test(arguments: ["archive", "trash"])
    func cappedFullSyncPreservesUnlistedCachedMailAndStopsAt500(mailbox: String) async throws {
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            StubURLProtocol.route { request in
                let path = request.url?.path ?? ""
                if path.hasSuffix("/profile") {
                    return (200, Data(#"{"emailAddress":"a@b.c","historyId":"100"}"#.utf8))
                }
                if path.hasSuffix("/messages") {
                    let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
                    let query = items.first { $0.name == "q" }!.value!
                    let matches = mailbox == "trash" ? query == "in:trash" : query.hasPrefix("-in:inbox")
                    guard matches else { return (200, Data(#"{}"#.utf8)) }
                    let start = Int(items.first { $0.name == "pageToken" }?.value ?? "0")!
                    let count = Int(items.first { $0.name == "maxResults" }!.value!)!
                    let messages = (start..<(start + count)).map { #"{"id":"m\#($0)","threadId":"t"}"# }.joined(separator: ",")
                    return (200, Data("{\"messages\":[\(messages)],\"nextPageToken\":\"\(start + count)\"}".utf8))
                }
                if request.url?.lastPathComponent == "gone" { return (404, Data()) }
                let labels = mailbox == "trash" ? #"["TRASH"]"# : "[]"
                return (200, Data("{\"id\":\"\(request.url!.lastPathComponent)\",\"labelIds\":\(labels)}".utf8))
            }
            let (_, cache, sync, _) = try makeStack(defaults: defaults)
            try cache.upsert(email: Fixtures.email(id: -1), gmailId: "older", threadId: "t", mailbox: mailbox == "trash" ? .trash : .archive)
            try cache.upsert(email: Fixtures.email(id: -2), gmailId: "gone", threadId: "t", mailbox: .inbox)
            try await sync.fullSnapshot()
            #expect(cache.gmailID(for: GmailMessageMapper.stableNumericID(for: "older")) == "older")
            #expect(cache.gmailID(for: -2) == nil)
            #expect(cache.count == 501)
            let fetches = StubURLProtocol.requests.filter { $0.url?.path.contains("/messages/m") == true }
            #expect(fetches.count == 500)
            #expect(StubURLProtocol.requestCount(to: "/messages/older") == 1)
            #expect(StubURLProtocol.requestCount(to: "/messages/gone") == 1)
            #expect(StubURLProtocol.requests.filter { $0.url?.path.hasSuffix("/messages") == true && $0.url?.query?.contains("pageToken") != true }.count == 4)
        }
    }

    // MARK: Cache

    @Test func cacheUpsertIsKeyedByGmailIDAndRoundTrips() throws {
        let cache = try EmailCacheStore(inMemory: true)
        let original = Fixtures.email(id: 123, sender: "a@b.c", subject: "Hi", starred: true)

        try cache.upsert(email: original, gmailId: "gm1", threadId: "t")
        #expect(cache.count == 1)
        #expect(cache.gmailID(for: 123) == "gm1")
        #expect(cache.threadID(for: 123) == "t")

        let edited = Fixtures.email(id: 123, sender: "a@b.c", subject: "Hi (edited)", starred: false)
        try cache.upsert(email: edited, gmailId: "gm1", threadId: "t")
        #expect(cache.count == 1)
        #expect(try cache.all().first?.subject == "Hi (edited)")

        try cache.setStarred(numericId: 123, starred: true)
        #expect(try cache.all().first?.starred == true)

        try cache.remove(gmailIds: ["gm1"])
        #expect(cache.isEmpty)
    }

    @Test func cacheWipeClearsEverythingForSignOut() throws {
        let cache = try EmailCacheStore(inMemory: true)
        try cache.upsert(email: Fixtures.email(id: 1), gmailId: "g1", threadId: "t")
        try cache.wipe()
        #expect(cache.isEmpty)
    }

    @Test func cacheStoresMailboxUnreadAndAttachments() throws {
        let cache = try EmailCacheStore(inMemory: true)
        let attachment = EmailAttachment(id: "att-1", partId: "1.1", filename: "invoice.pdf", mimeType: "application/pdf", size: 4242)
        let email = WinnowEmail(
            id: 7, sender: "a@b.c", name: nil, email: nil,
            receivedAt: 1_000, subject: "Hi", body: "body", type: "",
            starred: false, urgent: false, unread: true,
            bodyHTML: "<b>Hi</b>", attachments: [attachment]
        )

        try cache.upsert(email: email, gmailId: "g7", threadId: "t7", mailbox: .archive)
        #expect(try cache.all(mailbox: .archive).map(\.id) == [7])
        #expect(try cache.all().isEmpty)                     // not in the inbox bucket
        #expect(try cache.all(mailbox: .archive).first?.unread == true)
        #expect(try cache.all(mailbox: .archive).first?.bodyHTML == "<b>Hi</b>")
        #expect(cache.attachments(numericId: 7).first?.filename == "invoice.pdf")

        // Bucket and read-state move independently.
        try cache.setMailbox(numericId: 7, mailbox: .inbox)
        try cache.setUnread(numericId: 7, unread: false)
        #expect(try cache.all().isEmpty == false)
        #expect(try cache.all().first?.unread == false)

        // keepOnly drops messages that left every tracked view.
        try cache.upsert(email: Fixtures.email(id: 8), gmailId: "g8", threadId: "t8")
        try cache.keepOnly(gmailIds: ["g7"])
        #expect(try cache.all().map(\.id) == [7])
    }
}

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

    @Test func remoteArchiveViaLabelsRemovedInboxDropsTheRow() async throws {
        // H1: archiving from Gmail web/phone arrives as `labelsRemoved`
        // carrying INBOX — the row must leave the cache, not sit as a ghost.
        try await StubURLProtocol.exclusive {
            let suite = "winnow.tests.sync.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }

            StubURLProtocol.route { request in
                let path = request.url?.path ?? ""
                if path.hasSuffix("/history") {
                    let json = """
                    {"history":[{"id":"h1","labelsRemoved":[{"message":{"id":"m1","threadId":"t1","labelIds":["INBOX"]}}]}],"historyId":"890"}
                    """
                    return (200, Data(json.utf8))
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

            #expect(emails.isEmpty)
            #expect(cache.count == 0)
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
        #expect(cache.count == 0)
    }

    @Test func cacheWipeClearsEverythingForSignOut() throws {
        let cache = try EmailCacheStore(inMemory: true)
        try cache.upsert(email: Fixtures.email(id: 1), gmailId: "g1", threadId: "t")
        try cache.wipe()
        #expect(cache.count == 0)
    }
}

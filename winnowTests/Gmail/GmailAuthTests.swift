import Foundation
import Testing
@testable import winnow

@MainActor
struct GmailAuthTests {

    // MARK: PKCE

    @Test func pkceMatchesTheRFC7636TestVector() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        #expect(pkce.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func freshPKCEVerifiersMeetTheSpecLengthAndCharset() {
        let pkce = PKCE()
        #expect(pkce.verifier.count == 43)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        #expect(pkce.verifier.unicodeScalars.allSatisfy { allowed.contains($0) })
        #expect(pkce.verifier != PKCE().verifier)
    }

    // MARK: Credentials

    @Test func credentialsParseFromPlistData() throws {
        let data = try PropertyListSerialization.data(
            fromPropertyList: ["ClientID": "1234-abc.apps.googleusercontent.com", "ClientSecret": ""],
            format: .xml, options: 0
        )
        let credentials = try GmailCredentials(plistData: data)
        #expect(credentials.clientID == "1234-abc.apps.googleusercontent.com")
        #expect(credentials.clientSecret == nil)
        #expect(GmailCredentials.scope.contains("gmail.modify"))
    }

    @Test func placeholderOrMissingClientIDFailsLoudly() throws {
        let placeholder = try PropertyListSerialization.data(
            fromPropertyList: ["ClientID": "YOUR-CLIENT-ID.apps.googleusercontent.com"],
            format: .xml, options: 0
        )
        #expect(throws: GmailConfigError.malformed) { try GmailCredentials(plistData: placeholder) }

        let empty = try PropertyListSerialization.data(
            fromPropertyList: ["ClientID": ""], format: .xml, options: 0
        )
        #expect(throws: GmailConfigError.malformed) { try GmailCredentials(plistData: empty) }
    }

    @Test func missingCredentialsFileThrowsWithSetupCopy() {
        // The unit-test bundle ships no GmailCredentials.plist (the app bundle
        // legitimately may, once the developer adds theirs — so never probe
        // .main here).
        let testBundle = Bundle(for: StubURLProtocol.self)
        #expect(throws: GmailConfigError.missing) { try GmailCredentials.load(bundle: testBundle) }
    }

    @Test func formEncodeProducesFormURLEncodedPairs() {
        let body = String(data: TokenManager.formEncode([
            "grant_type": "refresh_token",
            "client_id": "abc-def.apps.googleusercontent.com"
        ]), encoding: .utf8) ?? ""
        #expect(body.contains("grant_type=refresh_token"))
        #expect(body.contains("client_id=abc-def.apps.googleusercontent.com"))
        #expect(!body.contains(" "))
    }

    // MARK: TokenManager

    private func makeManager(store: InMemoryTokenStore, session: URLSession) -> TokenManager {
        TokenManager(
            store: store,
            credentialsProvider: {
                try GmailCredentials(plistData: try! PropertyListSerialization.data(
                    fromPropertyList: ["ClientID": "test-client.apps.googleusercontent.com"],
                    format: .xml, options: 0
                ))
            },
            session: session
        )
    }

    @Test func expiredTokenTriggersExactlyOneRefresh() async throws {
        try await StubURLProtocol.exclusive {
            StubURLProtocol.route { request in
                if request.url?.host == "oauth2.googleapis.com" {
                    let json = #"{"access_token":"fresh-token","expires_in":3600,"token_type":"Bearer"}"#
                    return (200, Data(json.utf8))
                }
                return (500, Data())
            }
            let session = URLSession(configuration: StubURLProtocol.config)
            let store = InMemoryTokenStore()
            let manager = self.makeManager(store: store, session: session)

            let fixedNow = Date(timeIntervalSince1970: 1_000_000)
            manager.now = { fixedNow }
            manager.adopt(TokenSet(accessToken: "stale", refreshToken: "r1", expiresAt: fixedNow.addingTimeInterval(-60), scope: nil))

            let token = try await manager.validAccessToken()
            #expect(token == "fresh-token")
            #expect(store.saveCount == 2)   // adopt + refreshed persist
            #expect(manager.hasRefreshToken)

            // Second call inside the fresh window must not hit the token endpoint again.
            let before = StubURLProtocol.requests.count
            _ = try await manager.validAccessToken()
            #expect(StubURLProtocol.requests.count == before)
        }
    }

    @Test func adoptDuringRefreshStopsTheStaleResultFromWinning() async throws {
        // M1: a refresh computed from the OLD session must never overwrite or
        // resurrect state after a concurrent adopt (re-sign-in).
        try await StubURLProtocol.exclusive {
            let releaseRefresh = DispatchSemaphore(value: 0)
            StubURLProtocol.route { _ in
                _ = releaseRefresh.wait(timeout: .now() + 5)
                let json = #"{"access_token":"stale-session","expires_in":3600,"token_type":"Bearer"}"#
                return (200, Data(json.utf8))
            }
            let session = URLSession(configuration: StubURLProtocol.config)
            let store = InMemoryTokenStore()
            let manager = self.makeManager(store: store, session: session)
            manager.adopt(TokenSet(accessToken: "old", refreshToken: "r1", expiresAt: Date().addingTimeInterval(-60), scope: nil))

            let refreshTask = Task { try await manager.validAccessToken() }
            // Let the refresh get in flight (the handler parks it there).
            await waitForInFlightTokenRequest()

            // Re-sign-in while the stale refresh is mid-air.
            manager.adopt(TokenSet(accessToken: "new-session", refreshToken: "r2", expiresAt: Date().addingTimeInterval(3600), scope: nil))
            releaseRefresh.signal()

            let racedToken = try await refreshTask.value

            // The race loser sees the newer session instead of resurrecting
            // its own result, and nothing was persisted from the stale run.
            #expect(racedToken == "new-session")
            #expect(try await manager.validAccessToken() == "new-session")
            #expect(manager.hasSession)
            #expect(store.saveCount == 2)   // both adopts only — no stale persist
            #expect(StubURLProtocol.requestCount(to: "token") == 1)
        }
    }

    @Test func clearDuringRefreshStopsTheRevivedTokenFromResurrecting() async throws {
        try await StubURLProtocol.exclusive {
            let releaseRefresh = DispatchSemaphore(value: 0)
            StubURLProtocol.route { _ in
                _ = releaseRefresh.wait(timeout: .now() + 5)
                let json = #"{"access_token":"zombie","expires_in":3600,"token_type":"Bearer"}"#
                return (200, Data(json.utf8))
            }
            let session = URLSession(configuration: StubURLProtocol.config)
            let store = InMemoryTokenStore()
            let manager = self.makeManager(store: store, session: session)
            manager.adopt(TokenSet(accessToken: "old", refreshToken: "r1", expiresAt: Date().addingTimeInterval(-60), scope: nil))

            let refreshTask = Task { try await manager.validAccessToken() }
            await waitForInFlightTokenRequest()

            // Sign-out (revoked) lands while the refresh is mid-air.
            manager.clear()
            releaseRefresh.signal()

            // The raced caller must not hand out the zombie token.
            await #expect(throws: GmailConfigError.reauthRequired) {
                _ = try await refreshTask.value
            }
            // And the session stays cleared.
            await #expect(throws: GmailConfigError.reauthRequired) {
                _ = try await manager.validAccessToken()
            }
            #expect(!manager.hasSession)
            #expect(store.saveCount == 1)   // adopt only
        }
    }

    private func beginRefresh(_ manager: TokenManager) async -> Task<String, Error> {
        let (started, continuation) = AsyncStream<Void>.makeStream()
        let task = Task {
            continuation.yield(())
            return try await manager.forceRefresh()
        }
        for await _ in started { break }
        return task
    }

    @Test(.timeLimit(.minutes(1))) func concurrentRefreshesShareOneRequestEvenIfAWaiterIsCancelled() async throws {
        try await StubURLProtocol.exclusive {
            let requests = PausedTokenRequests(expectedCount: 2)
            let session = URLSession(configuration: PausedTokenURLProtocol.config(requests))
            defer { session.invalidateAndCancel() }
            let store = InMemoryTokenStore()
            let manager = self.makeManager(store: store, session: session)
            manager.adopt(TokenSet(accessToken: "old", refreshToken: "r1", expiresAt: .distantPast, scope: nil))

            let first = await beginRefresh(manager)
            let request = try await requests.next()
            let second = await beginRefresh(manager)
            let cancelled = await beginRefresh(manager)
            cancelled.cancel()
            request.complete(status: 200)

            #expect(try await first.value == "refreshed")
            #expect(try await second.value == "refreshed")
            #expect(try await cancelled.value == "refreshed")
            #expect(requests.count == 1)
            #expect(store.saveCount == 2)
            #expect(manager.lastError == nil)

            let forced = await beginRefresh(manager)
            let next = try await requests.next()
            next.complete(status: 200)
            #expect(try await forced.value == "refreshed")
            #expect(requests.count == 2)
        }
    }

    @Test(.timeLimit(.minutes(1)), arguments: [400, 401, 500, 200, -1])
    func adoptDuringRefreshDiscardsStaleErrors(status: Int) async throws {
        try await StubURLProtocol.exclusive {
            let requests = PausedTokenRequests(expectedCount: 1)
            let session = URLSession(configuration: PausedTokenURLProtocol.config(requests))
            defer { session.invalidateAndCancel() }
            let store = InMemoryTokenStore()
            let manager = self.makeManager(store: store, session: session)
            manager.adopt(TokenSet(accessToken: "old", refreshToken: "r1", expiresAt: .distantPast, scope: nil))

            let first = await beginRefresh(manager)
            let request = try await requests.next()
            let joined = await beginRefresh(manager)
            manager.adopt(TokenSet(accessToken: "new-session", refreshToken: "r2", expiresAt: .distantFuture, scope: nil))
            request.complete(status: status, body: Data("invalid response".utf8))

            #expect(try await first.value == "new-session")
            #expect(try await joined.value == "new-session")
            #expect(try await manager.validAccessToken() == "new-session")
            #expect(try store.load()?.refreshToken == "r2")
            #expect(store.saveCount == 2)
            #expect(store.clearCount == 0)
            #expect(manager.lastError == nil)
            #expect(requests.count == 1)
        }
    }

    @Test(.timeLimit(.minutes(1)), arguments: [400, 401, 500, 200, -1])
    func clearDuringRefreshDiscardsStaleErrors(status: Int) async throws {
        try await StubURLProtocol.exclusive {
            let requests = PausedTokenRequests(expectedCount: 1)
            let session = URLSession(configuration: PausedTokenURLProtocol.config(requests))
            defer { session.invalidateAndCancel() }
            let store = InMemoryTokenStore()
            let manager = self.makeManager(store: store, session: session)
            manager.adopt(TokenSet(accessToken: "old", refreshToken: "r1", expiresAt: .distantPast, scope: nil))

            let first = await beginRefresh(manager)
            let request = try await requests.next()
            let joined = await beginRefresh(manager)
            manager.clear()
            request.complete(status: status, body: Data("invalid response".utf8))

            await #expect(throws: GmailConfigError.reauthRequired) { try await first.value }
            await #expect(throws: GmailConfigError.reauthRequired) { try await joined.value }
            #expect(!manager.hasSession)
            #expect(try store.load() == nil)
            #expect(store.clearCount == 1)
            #expect(manager.lastError == nil)
            #expect(requests.count == 1)
        }
    }

    @Test(.timeLimit(.minutes(1)), arguments: [false, true], [200, 400, 500, -1])
    func staleCompletionCannotDetachANewerRefresh(clearFirst: Bool, status: Int) async throws {
        try await StubURLProtocol.exclusive {
            let requests = PausedTokenRequests(expectedCount: 2)
            let session = URLSession(configuration: PausedTokenURLProtocol.config(requests))
            defer { session.invalidateAndCancel() }
            let store = InMemoryTokenStore()
            let manager = self.makeManager(store: store, session: session)
            manager.adopt(TokenSet(accessToken: "old", refreshToken: "r1", expiresAt: .distantPast, scope: nil))

            let old = await beginRefresh(manager)
            let oldRequest = try await requests.next()
            if clearFirst { manager.clear() }
            manager.adopt(TokenSet(accessToken: "new", refreshToken: "r2", expiresAt: .distantPast, scope: nil))
            let current = await beginRefresh(manager)
            let currentRequest = try await requests.next()
            oldRequest.complete(status: status)
            await #expect(throws: GmailConfigError.reauthRequired) { try await old.value }
            #expect(manager.lastError == nil)

            let joined = await beginRefresh(manager)
            currentRequest.complete(status: 200)
            #expect(try await current.value == "refreshed")
            #expect(try await joined.value == "refreshed")
            #expect(requests.count == 2)
            #expect(store.saveCount == 3)
            #expect(store.clearCount == (clearFirst ? 1 : 0))
            #expect(try store.load()?.refreshToken == "r2")
            #expect(manager.lastError == nil)
        }
    }

    @Test(.timeLimit(.minutes(1))) func staleFailureCannotOverwriteTheCurrentRefreshError() async throws {
        try await StubURLProtocol.exclusive {
            let requests = PausedTokenRequests(expectedCount: 2)
            let session = URLSession(configuration: PausedTokenURLProtocol.config(requests))
            defer { session.invalidateAndCancel() }
            let manager = self.makeManager(store: InMemoryTokenStore(), session: session)
            manager.adopt(TokenSet(accessToken: "old", refreshToken: "r1", expiresAt: .distantPast, scope: nil))
            let old = await beginRefresh(manager)
            let oldRequest = try await requests.next()

            manager.clear()
            manager.adopt(TokenSet(accessToken: "new", refreshToken: "r2", expiresAt: .distantPast, scope: nil))
            let current = await beginRefresh(manager)
            let currentRequest = try await requests.next()
            currentRequest.complete(status: 503, body: Data())
            await #expect(throws: GmailAPIError.http(status: 503, bodySnippet: "")) { try await current.value }
            oldRequest.complete(status: 500, body: Data())
            await #expect(throws: GmailConfigError.reauthRequired) { try await old.value }
            #expect(manager.lastError as? GmailAPIError == .http(status: 503, bodySnippet: ""))
        }
    }

    @Test(.timeLimit(.minutes(1))) func successfulRefreshAndLifecycleChangesResetLastError() async throws {
        try await StubURLProtocol.exclusive {
            let requests = PausedTokenRequests(expectedCount: 4)
            let session = URLSession(configuration: PausedTokenURLProtocol.config(requests))
            defer { session.invalidateAndCancel() }
            let manager = self.makeManager(store: InMemoryTokenStore(), session: session)
            let tokens = TokenSet(accessToken: "old", refreshToken: "r1", expiresAt: .distantPast, scope: nil)
            manager.adopt(tokens)

            for recovery in 0..<3 {
                let failed = await beginRefresh(manager)
                let request = try await requests.next()
                request.complete(status: 500, body: Data())
                await #expect(throws: GmailAPIError.http(status: 500, bodySnippet: "")) { try await failed.value }
                #expect(manager.lastError as? GmailAPIError == .http(status: 500, bodySnippet: ""))
                if recovery == 0 {
                    let succeeded = await beginRefresh(manager)
                    let retry = try await requests.next()
                    retry.complete(status: 200)
                    #expect(try await succeeded.value == "refreshed")
                } else if recovery == 1 {
                    manager.adopt(tokens)
                } else {
                    manager.clear()
                }
                #expect(manager.lastError == nil)
            }
            #expect(requests.count == 4)
        }
    }

    @Test func revokedRefreshTokenClearsTheSessionAndDemandsReauth() async throws {
        try await StubURLProtocol.exclusive {
            StubURLProtocol.route { _ in (400, Data(#"{"error":"invalid_grant"}"#.utf8)) }
            let session = URLSession(configuration: StubURLProtocol.config)
            let store = InMemoryTokenStore()
            let manager = self.makeManager(store: store, session: session)
            manager.adopt(TokenSet(accessToken: "a", refreshToken: "r", expiresAt: Date().addingTimeInterval(-1), scope: nil))

            await #expect(throws: GmailConfigError.reauthRequired) {
                _ = try await manager.validAccessToken()
            }
            #expect(!manager.hasSession)
            #expect(store.clearCount == 1)
        }
    }

    /// Waits until the refresh is genuinely in flight, so the race milestone
    /// (concurrent adopt/clear while the token request parks on its semaphore)
    /// fires deterministically no matter how loaded the runner is.
    private func waitForInFlightTokenRequest() async {
        let start = Date()
        while StubURLProtocol.requestCount(to: "token") == 0 {
            if Date().timeIntervalSince(start) > 5 {
                Issue.record("Timed out waiting for the in-flight token refresh")
                return
            }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    @Test func missingRefreshTokenIsReauthNotACrash() async throws {
        try await StubURLProtocol.exclusive {
            StubURLProtocol.route { _ in (500, Data()) }
            let session = URLSession(configuration: StubURLProtocol.config)
            let manager = self.makeManager(store: InMemoryTokenStore(), session: session)
            manager.adopt(TokenSet(accessToken: "a", refreshToken: nil, expiresAt: Date().addingTimeInterval(-1), scope: nil))

            await #expect(throws: GmailConfigError.reauthRequired) {
                _ = try await manager.validAccessToken()
            }
        }
    }

    // MARK: Keychain

    @Test func keychainStoreRoundTripsAndClears() throws {
        let store = KeychainTokenStore(service: "com.stormofthoughts.winnow.tests.\(UUID().uuidString)", account: "oauth")
        defer { try? store.clear() }

        #expect(try store.load() == nil)

        let tokens = TokenSet(accessToken: "a", refreshToken: "r", expiresAt: Date(), scope: "s")
        try store.save(tokens)
        #expect(try store.load() == tokens)

        let updated = TokenSet(accessToken: "a2", refreshToken: "r", expiresAt: Date(), scope: "s")
        try store.save(updated)
        #expect(try store.load() == updated)

        try store.clear()
        #expect(try store.load() == nil)
    }
}

private struct PausedTokenRequest: @unchecked Sendable {
    let protocolInstance: PausedTokenURLProtocol

    func complete(status: Int, body: Data = Data(#"{"access_token":"refreshed","expires_in":3600}"#.utf8)) {
        protocolInstance.complete(status: status, body: body)
    }
}

private final class PausedTokenRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedCount = 0
    private let expectedCount: Int
    private let stream: AsyncStream<PausedTokenRequest>
    private let continuation: AsyncStream<PausedTokenRequest>.Continuation

    init(expectedCount: Int) {
        self.expectedCount = expectedCount
        (stream, continuation) = AsyncStream.makeStream()
    }

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return recordedCount
    }

    func record(_ request: PausedTokenURLProtocol) {
        lock.lock()
        recordedCount += 1
        let unexpected = recordedCount > expectedCount
        lock.unlock()
        if unexpected {
            Issue.record("Unexpected extra token refresh")
            request.complete(status: 500, body: Data())
        } else {
            continuation.yield(PausedTokenRequest(protocolInstance: request))
        }
    }

    func next() async throws -> PausedTokenRequest {
        try await withThrowingTaskGroup(of: PausedTokenRequest.self) { group in
            group.addTask { [stream] in
                for await request in stream { return request }
                throw CancellationError()
            }
            group.addTask {
                try await Task.sleep(for: .seconds(5))
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            let request = try await group.next()
            return try #require(request)
        }
    }
}

private final class PausedTokenURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var requests: PausedTokenRequests?
    private let completionLock = NSLock()
    private var completed = false

    static func config(_ requests: PausedTokenRequests) -> URLSessionConfiguration {
        lock.lock()
        Self.requests = requests
        lock.unlock()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Self.self]
        return configuration
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let requests = Self.requests
        Self.lock.unlock()
        requests?.record(self)
    }

    func complete(status: Int, body: Data = Data(#"{"access_token":"refreshed","expires_in":3600}"#.utf8)) {
        completionLock.lock(); defer { completionLock.unlock() }
        guard !completed else { return }
        completed = true
        if status == -1 {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {
        completionLock.lock(); defer { completionLock.unlock() }
        completed = true
    }
}

/// URLProtocol stub shared by the Gmail client/sync tests.
///
/// PARALLELISM NOTE: Swift Testing runs tests concurrently, but the stub's
/// routing table is process-global (URLProtocol classes are registered per
/// configuration, and URLSession loads off the main actor). Every stub-using
/// test therefore wraps its body in `StubURLProtocol.exclusive { … }`, which
/// serializes access across suites — no handler can be swapped mid-flight by
/// a sibling test.
final class StubURLProtocol: URLProtocol {
    private static let gate = AsyncGate()
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: ((URLRequest) -> (Int, Data))?
    nonisolated(unsafe) private static var recorded: [URLRequest] = []

    static func exclusive<T>(_ body: () async throws -> T) async rethrows -> T {
        await gate.wait()
        defer { gate.signal() }
        return try await body()
    }

    static var config: URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return configuration
    }

    static var requests: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    static func route(_ handler: @escaping (URLRequest) -> (Int, Data)) {
        lock.lock(); defer { lock.unlock() }
        Self.handler = handler
        recorded = []
    }

    static func requestCount(to pathContains: String) -> Int {
        requests.filter { $0.url?.path.contains(pathContains) == true }.count
    }

    /// POST bodies arrive as a stream in URLProtocol; read them back.
    static func bodyData(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        let handler = Self.handler
        Self.recorded.append(request)
        Self.lock.unlock()
        guard let handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let (status, data) = handler(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// Minimal async mutex (fair FIFO) used by `StubURLProtocol.exclusive`.
final class AsyncGate: Sendable {
    private let lock = NSLock()
    nonisolated(unsafe) private var waiters: [CheckedContinuation<Void, Never>] = []
    nonisolated(unsafe) private var held = false

    func wait() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            lock.lock(); defer { lock.unlock() }
            if !held {
                held = true
                continuation.resume()
            } else {
                waiters.append(continuation)
            }
        }
    }

    func signal() {
        lock.lock(); defer { lock.unlock() }
        if let next = waiters.first {
            waiters.removeFirst()
            next.resume()
        } else {
            held = false
        }
    }
}

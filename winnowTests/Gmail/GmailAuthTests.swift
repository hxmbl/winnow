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
        #expect(credentials.redirectURI == "com.googleusercontent.apps.1234-abc.apps.googleusercontent.com:/oauthredirect")
        #expect(credentials.callbackScheme == "com.googleusercontent.apps.1234-abc.apps.googleusercontent.com")
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
        // The test-host app bundle ships no GmailCredentials.plist.
        #expect(throws: GmailConfigError.missing) { try GmailCredentials.load(bundle: .main) }
    }

    @Test func formEncodeProducesFormURLEncodedPairs() {
        let body = String(data: TokenManager.formEncode([
            "grant_type": "refresh_token",
            "client_id": "abc-def.apps.googleusercontent.com",
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

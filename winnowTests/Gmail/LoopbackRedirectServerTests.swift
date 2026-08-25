import Foundation
import Testing
@testable import winnow

@MainActor
struct LoopbackRedirectServerTests {

    // MARK: Request-line parsing

    @Test func parseTargetExtractsPathAndQuery() {
        let head = "GET /?code=abc123&state=xyz&scope=gmail.modify HTTP/1.1\r\nHost: 127.0.0.1:49152\r\n\r\n"
        let url = LoopbackRedirectServer.parseTarget(fromHead: head)
        #expect(url?.path == "/")
        #expect(url?.query?.contains("code=abc123") == true)
    }

    @Test func parseTargetRejectsNonGETAndNonRoot() {
        #expect(LoopbackRedirectServer.parseTarget(fromHead: "POST /?code=x HTTP/1.1\r\n\r\n") == nil)
        #expect(LoopbackRedirectServer.parseTarget(fromHead: "GET /favicon.ico HTTP/1.1\r\n\r\n")?.path == "/favicon.ico")
        #expect(LoopbackRedirectServer.parseTarget(fromHead: "garbage") == nil)
        #expect(LoopbackRedirectServer.parseTarget(fromHead: "") == nil)
    }

    // MARK: Live round-trip (loopback is bound inside the sandboxed test host)

    @Test func liveRoundTripCapturesCodeAndAnswersBrowser() async throws {
        let server = try await LoopbackRedirectServer.start()
        #expect(server.port > 0)

        let waiter = Task { try await server.awaitCode(expectedState: "st4te", timeout: 10) }

        // Simulate the browser redirect hitting the loopback URL.
        let request = URLRequest(url: URL(string: "http://127.0.0.1:\(server.port)/?code=the-code&state=st4te")!)
        let (data, response) = try await URLSession.shared.data(for: request)

        let http = try #require(response as? HTTPURLResponse)
        #expect(http.statusCode == 200)
        let body = String(decoding: data, as: UTF8.self)
        #expect(body.contains("close this tab"))

        let code = try await waiter.value
        #expect(code == "the-code")
    }

    @Test func liveRoundTripRejectsWrongState() async throws {
        let server = try await LoopbackRedirectServer.start()

        let waiter = Task { try await server.awaitCode(expectedState: "expected", timeout: 10) }

        let request = URLRequest(url: URL(string: "http://127.0.0.1:\(server.port)/?code=c&state=evil")!)
        _ = try await URLSession.shared.data(for: request)

        await #expect(throws: GmailAPIError.self) {
            _ = try await waiter.value
        }
    }

    @Test func faviconRequestsDoNotFulfillTheWait() async throws {
        let server = try await LoopbackRedirectServer.start()

        let waiter = Task { try await server.awaitCode(expectedState: "s", timeout: 10) }

        // Browser noise first — must be answered 404 without settling.
        let noise = URLRequest(url: URL(string: "http://127.0.0.1:\(server.port)/favicon.ico")!)
        let (_, noiseResponse) = try await URLSession.shared.data(for: noise)
        #expect((noiseResponse as? HTTPURLResponse)?.statusCode == 404)
        #expect(!waiter.isCancelled)

        // Then the real redirect lands.
        let real = URLRequest(url: URL(string: "http://127.0.0.1:\(server.port)/?code=late&state=s")!)
        _ = try await URLSession.shared.data(for: real)

        let code = try await waiter.value
        #expect(code == "late")
    }
}

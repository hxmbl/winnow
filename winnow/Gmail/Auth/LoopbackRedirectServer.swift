import Foundation
import Network

/// Local HTTP listener that captures Google's OAuth redirect (RFC 8252
/// loopback flow).
///
/// SECURITY MODEL
/// - Bound to **127.0.0.1 only** on an OS-assigned ephemeral port — never any
///   LAN interface — and torn down after a single successful redirect.
/// - The `state` nonce is validated by the caller against the one embedded in
///   the authorize URL, so a malicious local app or page cannot inject its own
///   code (it would need the nonce).
/// - Only `GET /` with a `code`/`error` query fulfills the wait; anything else
///   (favicon requests, scanners) gets a 404 and the listener keeps waiting.
/// - The browser is shown a plain "you can close this tab" page; nothing from
///   the redirect (code, state) is reflected into that page.
final class LoopbackRedirectServer: @unchecked Sendable {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "winnow.oauth.loopback")
    private var listener: NWListener?
    private var continuation: CheckedContinuation<URL, Error>?
    private var capturedTarget: URL?
    private var settled = false
    private(set) var port: UInt16 = 0

    /// Parses the request target out of an HTTP request head's first line.
    /// Returns nil for anything that is not `GET /…`.
    nonisolated static func parseTarget(fromHead head: String) -> URL? {
        guard let requestLine = head
            .components(separatedBy: "\r\n")
            .first(where: { !$0.isEmpty }) else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2, parts[0] == "GET", parts[1].hasPrefix("/") else { return nil }
        return URL(string: "http://127.0.0.1" + parts[1])
    }

    /// Binds a loopback listener on a random free port.
    static func start() async throws -> LoopbackRedirectServer {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)

        let server = LoopbackRedirectServer()
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<LoopbackRedirectServer, Error>) in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    listener.stateUpdateHandler = nil
                    server.port = listener.port?.rawValue ?? 0
                    server.listener = listener
                    continuation.resume(returning: server)
                case .failed(let error):
                    continuation.resume(throwing: GmailAPIError.transport("loopback listener failed: \(error)"))
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak server] connection in
                server?.handle(connection)
            }
            listener.start(queue: server.queue)
        }
    }

    /// Waits for the browser to land on the loopback URL. Returns the `code`
    /// after validating `state`. Throws on Google-reported errors, state
    /// mismatch, or timeout.
    func awaitCode(expectedState: String, timeout: TimeInterval) async throws -> String {
        let target: URL = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
            lock.lock()
            if let captured = capturedTarget {
                settled = true
                lock.unlock()
                listener?.cancel()
                continuation.resume(returning: captured)
                return
            }
            self.continuation = continuation
            lock.unlock()
            queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.settle(.failure(GmailAPIError.transport(
                    "Sign-in timed out after \(Int(timeout))s. Close the browser tab and try again."
                )))
            }
        }

        guard let components = URLComponents(url: target, resolvingAgainstBaseURL: false) else {
            throw GmailAPIError.transport("unparseable redirect target: \(target.absoluteString)")
        }
        let items = components.queryItems ?? []
        if let error = items.first(where: { $0.name == "error" })?.value {
            throw GmailAPIError.transport("Google sign-in error: \(error)")
        }
        guard items.first(where: { $0.name == "state" })?.value == expectedState else {
            throw GmailAPIError.transport("OAuth state mismatch — redirect ignored")
        }
        guard let code = items.first(where: { $0.name == "code" })?.value else {
            throw GmailAPIError.transport("OAuth redirect carried no code")
        }
        return code
    }

    // MARK: - Connection handling

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveHead(connection, accumulated: Data())
    }

    private func receiveHead(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = accumulated
            if let data { buffer.append(data) }

            if let headEnd = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buffer[..<headEnd.lowerBound], as: UTF8.self)
                self.finishRequest(connection, head: head)
                return
            }
            if error != nil || isComplete || buffer.count > 1_000_000 {
                let head = String(decoding: buffer, as: UTF8.self)
                self.finishRequest(connection, head: head)
                return
            }
            self.receiveHead(connection, accumulated: buffer)
        }
    }

    private func finishRequest(_ connection: NWConnection, head: String) {
        guard let target = Self.parseTarget(fromHead: head) else {
            send(connection, status: "400 Bad Request", body: "Bad request", thenSettle: nil)
            return
        }

        let isRedirectTarget = target.path == "/" && !(target.query ?? "").isEmpty
        guard isRedirectTarget, Self.looksLikeOAuthRedirect(target) else {
            // favicon.ico, scanner noise, or a query that isn't an OAuth
            // redirect (a hostile local process poking the port): answer and
            // KEEP LISTENING — garbage must not settle the wait.
            send(connection, status: "404 Not Found", body: "Not found", thenSettle: nil)
            return
        }

        send(connection, status: "200 OK", body: Self.successPageHTML, thenSettle: .success(target))
    }

    /// True only for redirects shaped like Google's (`code=…`/`error=…`, with
    /// the `state` nonce). Anything else can never be a valid completion.
    private static func looksLikeOAuthRedirect(_ target: URL) -> Bool {
        let names = Set((URLComponents(url: target, resolvingAgainstBaseURL: false)?.queryItems ?? []).map(\.name))
        return names.contains("state") && (names.contains("code") || names.contains("error"))
    }

    private func send(_ connection: NWConnection, status: String, body: String, thenSettle outcome: Result<URL, Error>?) {
        let payload = Data(body.utf8)
        let head = "HTTP/1.1 \(status)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n"
        var response = Data(head.utf8)
        response.append(payload)
        connection.send(content: response, completion: .contentProcessed { [weak self] _ in
            connection.cancel()
            if let outcome { self?.settle(outcome) }
        })
    }

    /// Resumes the wait exactly once, from any path (handler or timeout).
    private func settle(_ outcome: Result<URL, Error>) {
        lock.lock()
        guard !settled else { lock.unlock(); return }
        settled = true
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        listener?.cancel()

        switch outcome {
        case .success(let url):
            // Remember the target in case the caller starts waiting *after*
            // the redirect already landed.
            lock.lock(); capturedTarget = url; lock.unlock()
            continuation?.resume(returning: url)
        case .failure(let error):
            continuation?.resume(throwing: error)
        }
    }

    private static let successPageHTML = """
        <!DOCTYPE html><html><head><meta charset="utf-8"><title>Winnow</title></head>
        <body style="font-family:-apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
        <div style="text-align:center"><h1>You're signed in</h1>
        <p style="color:#666">You can close this tab and return to Winnow.</p></div></body></html>
        """
}

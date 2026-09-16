import Foundation

/// Errors surfaced by the Gmail layer. `LocalizedError` copy is written for
/// display in the login screen / settings, so it names the fix, not the code.
enum GmailAPIError: LocalizedError, Equatable {
    /// Google rejected the refresh token (revoked, password change, 6-month
    /// dormancy). The stored session has been cleared; sign in again.
    case reauthRequired
    case http(status: Int, bodySnippet: String)
    case decoding(String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .reauthRequired:
            return "Your Google session has expired or was revoked. Sign in again to reconnect."
        case .http(let status, _):
            return "Gmail API returned HTTP \(status)."
        case .decoding(let detail):
            return "Unexpected Gmail API response (\(detail))."
        case .transport(let detail):
            return "Network problem talking to Gmail: \(detail)"
        }
    }
}

/// The typed surface of the Gmail REST API that Winnow uses.
///
/// SECURITY MODEL
/// - The only component that speaks to `gmail.googleapis.com`. Every request
///   carries `Authorization: Bearer <token>` obtained from `TokenManager`;
///   on a 401 the client force-refreshes **once** and retries — a second 401
///   propagates so the UI can demand re-auth instead of retry-looping.
/// - Logging is deliberately minimal: method, path, status. Never headers,
///   never bodies, never tokens — request bodies contain user email content.
/// - `session` is injectable so tests stub transport with `URLProtocol`
///   fixtures; production uses an ephemeral-session-based client.
@MainActor
final class GmailClient {
    nonisolated static let apiBase = "https://gmail.googleapis.com/gmail/v1/users/me"
    nonisolated static let maxPageSize = 200

    private let tokenManager: TokenManager
    private let session: URLSession

    init(tokenManager: TokenManager, session: URLSession) {
        self.tokenManager = tokenManager
        self.session = session
    }

    /// Production transport: ephemeral session (no shared cookie jar, no
    /// URL cache) — the API is bearer-token only, and cookies would be pure
    /// attack surface.
    static func productionSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.waitsForConnectivity = true
        return URLSession(configuration: configuration)
    }

    // MARK: - Endpoints

    func profile() async throws -> GmailProfile {
        try await get(path: "profile", query: [])
    }

    func listMessages(query: String, pageToken: String? = nil, maxResults: Int = GmailClient.maxPageSize) async throws -> GmailMessageList {
        var queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "maxResults", value: String(maxResults)),
        ]
        if let pageToken {
            queryItems.append(URLQueryItem(name: "pageToken", value: pageToken))
        }
        return try await get(path: "messages", query: queryItems)
    }

    func message(id: String) async throws -> GmailMessage {
        try await get(
            path: "messages/\(id)",
            query: [URLQueryItem(name: "format", value: "full")]
        )
    }

    /// Adds/removes labels atomically. Starring = `STARRED` label; archiving =
    /// removing `INBOX`; trashing = the dedicated trash endpoint.
    @discardableResult
    func modify(messageID: String, addLabelIds: [String]?, removeLabelIds: [String]?) async throws -> GmailMessage {
        let body = GmailModifyRequest(addLabelIds: addLabelIds, removeLabelIds: removeLabelIds)
        return try await post(path: "messages/\(messageID)/modify", body: body)
    }

    @discardableResult
    func trash(messageID: String) async throws -> GmailMessage {
        try await post(path: "messages/\(messageID)/trash", bodyData: nil)
    }

    @discardableResult
    func send(_ request: GmailSendRequest) async throws -> GmailMessage {
        try await post(path: "messages/send", bodyData: JSONEncoder().encode(request))
    }

    /// Fetches one attachment's bytes (base64url in the response `data`).
    func attachment(messageID: String, attachmentID: String) async throws -> GmailAttachment {
        try await get(
            path: "messages/\(messageID)/attachments/\(attachmentID)",
            query: []
        )
    }

    /// Permanently deletes a message from Gmail. Irreversible — only reachable
    /// from the Trash mailbox.
    @discardableResult
    func deletePermanent(messageID: String) async throws -> GmailMessage {
        var request = URLRequest(url: URL(string: "\(Self.apiBase)/messages/\(messageID)")!)
        request.httpMethod = "DELETE"
        return try await execute(request, expect: GmailMessage.self)
    }

    func historyList(startHistoryID: String, pageToken: String? = nil) async throws -> GmailHistoryList {
        var queryItems = [URLQueryItem(name: "startHistoryId", value: startHistoryID)]
        if let pageToken {
            queryItems.append(URLQueryItem(name: "pageToken", value: pageToken))
        }
        return try await get(path: "history", query: queryItems)
    }

    // MARK: - Transport

    private func get<T: Decodable>(path: String, query: [URLQueryItem]) async throws -> T {
        var components = URLComponents(string: "\(Self.apiBase)/\(path)")!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        return try await execute(request, expect: T.self)
    }

    private func post<T: Decodable>(path: String, body: GmailModifyRequest) async throws -> T {
        try await post(path: path, bodyData: JSONEncoder().encode(body))
    }

    private func post<T: Decodable>(path: String, bodyData: Data?) async throws -> T {
        var request = URLRequest(url: URL(string: "\(Self.apiBase)/\(path)")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = bodyData
        return try await execute(request, expect: T.self)
    }

    private func execute<T: Decodable>(_ request: URLRequest, expect: T.Type, isRetry: Bool = false) async throws -> T {
        var request = request
        request.setValue("Bearer \(try await tokenManager.validAccessToken())", forHTTPHeaderField: "Authorization")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GmailAPIError.transport("non-HTTP response")
        }

        log("\(request.httpMethod ?? "?") \(request.url?.path ?? "?") → \(http.statusCode)")

        if http.statusCode == 401 && !isRetry {
            // Access token expired/revoked mid-flight: mint a fresh one and
            // retry exactly once. A second 401 means re-auth, not a loop.
            _ = try await tokenManager.forceRefresh()
            return try await execute(request, expect: expect, isRetry: true)
        }

        guard (200..<300).contains(http.statusCode) else {
            throw GmailAPIError.http(
                status: http.statusCode,
                bodySnippet: String(data: data.prefix(200), encoding: .utf8) ?? ""
            )
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw GmailAPIError.decoding("\(T.self): \(error)")
        }
    }

    /// Deliberately the only log line in the Gmail layer: status codes only.
    private func log(_ line: String) {
        #if DEBUG
        print("[gmail]", line)
        #endif
    }
}

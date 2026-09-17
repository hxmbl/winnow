import Foundation

/// Owns the lifecycle of the stored `TokenSet`: hand out access tokens that
/// are known-good, refresh when stale, and hard-fail when the user must
/// re-consent.
///
/// SECURITY MODEL
/// - The **only** component besides `AuthController` that touches token
///   values. Everything else asks for a ready-to-use access token string and
///   can never see the refresh token.
/// - Access tokens are refreshed 60s before expiry to avoid clock-skew 401s.
/// - Refresh happens at most once per expiry window (single-flight): a burst
///   of API calls triggers one refresh, not one per call.
/// - Google answering `invalid_grant` (revoked/password-changed) clears the
///   Keychain immediately — a dead refresh token must not sit on disk.
/// - This type is MainActor like the rest of the app: token handling is not
///   the concurrency bottleneck, and one isolation domain keeps the audit
///   surface obvious.
@MainActor
final class TokenManager {
    private let store: TokenStore
    private let credentialsProvider: () throws -> GmailCredentials
    private let session: URLSession
    static let tokenURL = URL(string: "https://oauth2.googleapis.com/token")!

    /// Refresh this many seconds before the documented expiry.
    private let expirySlack: TimeInterval = 60
    var now: () -> Date = Date.init
    private(set) var lastError: Error?

    /// Non-nil when the Keychain itself failed at init — surfaced by the
    /// store so a keychain problem reads as a keychain problem, not as
    /// "please sign in again".
    private(set) var loadError: Error?

    /// Bumped by `adopt`/`clear` so an in-flight refresh computed from the
    /// OLD session can never overwrite or resurrect newer state.
    @ObservationIgnored private var generation = 0

    private var cached: TokenSet?
    private var inflightRefresh: Task<String, Error>?

    init(store: TokenStore, credentialsProvider: @escaping () throws -> GmailCredentials, session: URLSession = .shared) {
        self.store = store
        self.credentialsProvider = credentialsProvider
        self.session = session
        do {
            self.cached = try store.load()
        } catch {
            self.loadError = error
            self.cached = nil
        }
    }

    /// True when a stored token set exists (even if stale) — used to decide
    /// between "restore session silently" and "show the login screen".
    var hasSession: Bool { cached != nil }

    var hasRefreshToken: Bool { cached?.refreshToken != nil }

    /// Stores the outcome of a fresh interactive sign-in. Invalidates any
    /// in-flight refresh from the previous session.
    func adopt(_ tokens: TokenSet) {
        generation += 1
        inflightRefresh = nil
        lastError = nil
        cached = tokens
        do {
            try store.save(tokens)
        } catch {
            // Token is in memory but won't survive a restart — surface so
            // the user knows sign-in may not persist.
            lastError = error
            #if DEBUG
            print("[token-manager] failed to save tokens to Keychain: \(error)")
            #endif
        }
    }

    /// Forgets everything: Keychain first, then memory. An in-flight refresh
    /// is left to finish — the generation guard discards its result, so a
    /// stale refresh can never resurrect a cleared session.
    func clear() {
        generation += 1
        cached = nil
        inflightRefresh = nil
        lastError = nil
        do {
            try store.clear()
        } catch {
            // Dead refresh token may persist on disk — log for diagnostics.
            #if DEBUG
            print("[token-manager] failed to clear Keychain: \(error)")
            #endif
        }
    }

    /// Returns an access token guaranteed valid for at least `expirySlack`.
    /// Throws `GmailConfigError.reauthRequired` when no usable refresh token
    /// exists — the caller must send the user through sign-in again.
    func validAccessToken() async throws -> String {
        if let cached, cached.expiresAt.timeIntervalSince(now()) > expirySlack {
            return cached.accessToken
        }
        return try await refresh()
    }

    /// Forces a refresh even if the cached token looks fresh — used after a
    /// 401 so the retry actually has a new credential.
    func forceRefresh() async throws -> String {
        try await refresh()
    }

    private func refresh() async throws -> String {
        // Single-flight: the first caller creates the refresh task; concurrent
        // callers await the same task instead of stacking token requests.
        let gen = generation
        let task: Task<String, Error>
        if let inflight = inflightRefresh {
            task = inflight
        } else {
            task = Task<String, Error> { [weak self] in
                guard let self else { throw GmailConfigError.reauthRequired }
                guard gen == self.generation else { return try self.currentAccessToken() }
                defer {
                    if gen == self.generation {
                        self.inflightRefresh = nil
                    }
                }
                do {
                    let token = try await self.performRefresh(generation: gen)
                    if gen == self.generation {
                        self.lastError = nil
                    }
                    return token
                } catch {
                    guard gen == self.generation else { return try self.currentAccessToken() }
                    self.lastError = error
                    throw error
                }
            }
            inflightRefresh = task
        }
        let result = await task.result
        guard gen == generation else { return try currentAccessToken() }
        return try result.get()
    }

    private func currentAccessToken() throws -> String {
        guard let cached, cached.expiresAt.timeIntervalSince(now()) > expirySlack else {
            throw GmailConfigError.reauthRequired
        }
        return cached.accessToken
    }

    private func performRefresh(generation gen: Int) async throws -> String {
        guard let tokens = cached, let refreshToken = tokens.refreshToken else {
            clear()
            lastError = GmailConfigError.reauthRequired
            throw GmailConfigError.reauthRequired
        }
        let credentials = try credentialsProvider()

        var request = URLRequest(url: Self.tokenURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = [
            "client_id": credentials.clientID,
            "refresh_token": refreshToken,
            "grant_type": "refresh_token",
        ]
        if let secret = credentials.clientSecret {
            form["client_secret"] = secret
        }
        request.httpBody = Self.formEncode(form)

        let (data, response) = try await session.data(for: request)
        guard gen == generation else { return try currentAccessToken() }
        guard let http = response as? HTTPURLResponse else {
            throw GmailAPIError.transport("non-HTTP token response")
        }

        struct RefreshResponse: Decodable {
            let accessToken: String
            let expiresIn: Int
            let scope: String?
            enum CodingKeys: String, CodingKey {
                case accessToken = "access_token"
                case expiresIn = "expires_in"
                case scope
            }
        }

        guard (200..<300).contains(http.statusCode) else {
            // invalid_grant / revoked → the stored session is worthless.
            if http.statusCode == 400 || http.statusCode == 401 {
                clear()
                lastError = GmailConfigError.reauthRequired
                throw GmailConfigError.reauthRequired
            }
            throw GmailAPIError.http(status: http.statusCode, bodySnippet: String(data: data.prefix(200), encoding: .utf8) ?? "")
        }

        let decoded: RefreshResponse
        do {
            decoded = try JSONDecoder().decode(RefreshResponse.self, from: data)
        } catch {
            throw GmailAPIError.decoding("token refresh: \(error)")
        }

        // M10: floor the stored lifetime so a pathological expires_in ≤ slack
        // can never cause a refresh on every call. A genuinely shorter-lived
        // token simply 401s once and is force-refreshed by the client.
        let lifetime = max(TimeInterval(decoded.expiresIn), expirySlack + 5)
        let updated = TokenSet(
            accessToken: decoded.accessToken,
            refreshToken: refreshToken,
            expiresAt: now().addingTimeInterval(lifetime),
            scope: decoded.scope ?? tokens.scope
        )

        // The session changed while we were in flight (re-sign-in or clear):
        // the stale result must not win.
        guard gen == generation else {
            if let current = cached, current.expiresAt.timeIntervalSince(now()) > expirySlack {
                return current.accessToken
            }
            throw GmailConfigError.reauthRequired
        }

        cached = updated
        do {
            try store.save(updated)
        } catch {
            #if DEBUG
            print("[token-manager] failed to persist refreshed token: \(error)")
            #endif
        }
        return updated.accessToken
    }

    static func formEncode(_ fields: [String: String]) -> Data {
        var components = URLComponents()
        components.queryItems = fields.map { URLQueryItem(name: $0.key, value: $0.value) }
        // queryItems percent-encodes for a URL query, which is also valid
        // form-urlencoded body encoding for these ASCII field names/values.
        return Data(components.percentEncodedQuery?.data(using: .utf8) ?? Data())
    }
}

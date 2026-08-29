import AppKit
import CryptoKit
import Foundation

/// Runs the interactive Google sign-in: Authorization Code flow with PKCE,
/// opened in the **user's default browser** and completed via an RFC 8252
/// loopback redirect (`http://127.0.0.1:<ephemeral port>`).
///
/// SECURITY MODEL
/// - Loopback redirect: the listener binds 127.0.0.1 only (see
///   `LoopbackRedirectServer`); Desktop-type Google clients accept any
///   loopback port without pre-registration.
/// - PKCE (S256): the verifier exists only in memory and is sent solely to
///   Google's token endpoint over TLS; an intercepted authorize URL cannot be
///   redeemed.
/// - The `state` nonce binds the redirect to this flow; mismatches are
///   rejected before the code is used.
/// - `access_type=offline&prompt=consent` guarantees a refresh token on every
///   consent, so the app never guesses whether it holds a reusable session.
/// - Tokens go straight into `TokenManager` → Keychain. Nothing token-shaped
///   is logged or persisted anywhere else.
@MainActor
final class AuthController {
    static let authorizeURL = URL(string: "https://accounts.google.com/o/oauth2/v2/auth")!

    private let tokenManager: TokenManager
    private let session: URLSession
    /// Generous window for the user to finish the browser round-trip.
    private let redirectTimeout: TimeInterval

    init(tokenManager: TokenManager, session: URLSession = .shared, redirectTimeout: TimeInterval = 300) {
        self.tokenManager = tokenManager
        self.session = session
        self.redirectTimeout = redirectTimeout
    }

    /// Opens Google consent in the default browser and returns once tokens
    /// are stored in the keychain-backed manager.
    func signIn() async throws {
        let credentials = try GmailCredentials.load()
        let pkce = PKCE()
        let state = PKCE.base64url({
            var bytes = [UInt8](repeating: 0, count: 16)
            _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
            return Data(bytes)
        }())

        let server = try await LoopbackRedirectServer.start()
        let redirectURI = "http://127.0.0.1:\(server.port)"

        var components = URLComponents(url: Self.authorizeURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: credentials.clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "scope", value: GmailCredentials.scope),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "access_type", value: "offline"),
            URLQueryItem(name: "prompt", value: "consent"),
        ]
        guard let authorizeURL = components.url else {
            throw GmailAPIError.transport("could not build authorize URL")
        }

        // A missing/no-default browser returns false here; fail now rather
        // than burn the whole redirect timeout waiting for a tab that
        // will never open.
        guard NSWorkspace.shared.open(authorizeURL) else {
            throw GmailAPIError.transport("No default browser available to complete sign-in.")
        }

        let code = try await server.awaitCode(expectedState: state, timeout: redirectTimeout)
        let tokens = try await exchange(code: code, pkce: pkce, credentials: credentials, redirectURI: redirectURI)
        tokenManager.adopt(tokens)
    }

    /// Exchanges the authorization code for tokens (the only network call that
    /// carries the PKCE verifier or the optional client secret). `redirectURI`
    /// must be byte-identical to the one in the authorize request.
    private func exchange(code: String, pkce: PKCE, credentials: GmailCredentials, redirectURI: String) async throws -> TokenSet {
        var form = [
            "code": code,
            "client_id": credentials.clientID,
            "redirect_uri": redirectURI,
            "code_verifier": pkce.verifier,
            "grant_type": "authorization_code",
        ]
        if let secret = credentials.clientSecret {
            form["client_secret"] = secret
        }

        var request = URLRequest(url: TokenManager.tokenURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = TokenManager.formEncode(form)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GmailAPIError.http(status: status, bodySnippet: String(data: data.prefix(200), encoding: .utf8) ?? "")
        }

        struct ExchangeResponse: Decodable {
            let accessToken: String
            let expiresIn: Int
            let refreshToken: String?
            let scope: String
            enum CodingKeys: String, CodingKey {
                case accessToken = "access_token"
                case expiresIn = "expires_in"
                case refreshToken = "refresh_token"
                case scope
            }
        }
        let decoded: ExchangeResponse
        do {
            decoded = try JSONDecoder().decode(ExchangeResponse.self, from: data)
        } catch {
            throw GmailAPIError.decoding("token exchange: \(error)")
        }

        return TokenSet(
            accessToken: decoded.accessToken,
            refreshToken: decoded.refreshToken,
            expiresAt: Date().addingTimeInterval(TimeInterval(decoded.expiresIn)),
            scope: decoded.scope
        )
    }
}

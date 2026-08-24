import AppKit
import AuthenticationServices
import CryptoKit
import Foundation

/// Runs the interactive Google sign-in: Authorization Code flow with PKCE,
/// presented in the system web sheet.
///
/// SECURITY MODEL
/// - Uses `ASWebAuthenticationSession` (system-managed, sandbox-respecting)
///   with `prefersEphemeralWebSession` so the flow never shares the user's
///   browser cookies and leaves no login state behind.
/// - `access_type=offline&prompt=consent` guarantees Google returns a refresh
///   token on every consent, so the app never has to guess whether it holds a
///   reusable session.
/// - The state parameter is a random nonce bound to this specific flow; the
///   callback is rejected unless it echoes it, defeating cross-flow replay
///   (a malicious app firing the same custom scheme at us).
/// - The authorization *code* is exchanged server-side-of-the-client (direct
///   HTTPS POST to Google) with the PKCE verifier; the code never appears in
///   logs or storage.
/// - Tokens go straight into `TokenManager` → Keychain. Nothing token-shaped
///   is persisted anywhere else.
@MainActor
final class AuthController: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let authorizeURL = URL(string: "https://accounts.google.com/o/oauth2/v2/auth")!

    private let tokenManager: TokenManager
    private let session: URLSession
    private var activeWebSession: ASWebAuthenticationSession?

    init(tokenManager: TokenManager, session: URLSession = .shared) {
        self.tokenManager = tokenManager
        self.session = session
    }

    /// Presents the Google consent sheet and returns once tokens are stored.
    func signIn() async throws {
        let credentials = try GmailCredentials.load()
        let pkce = PKCE()
        let state = PKCE.base64url({
            var bytes = [UInt8](repeating: 0, count: 16)
            _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
            return Data(bytes)
        }())

        var components = URLComponents(url: Self.authorizeURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: credentials.clientID),
            URLQueryItem(name: "redirect_uri", value: credentials.redirectURI),
            URLQueryItem(name: "scope", value: GmailCredentials.scope),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "access_type", value: "offline"),
            URLQueryItem(name: "prompt", value: "consent"),
        ]

        let code = try await requestAuthorizationCode(url: components.url!, callbackScheme: credentials.callbackScheme, expectedState: state)
        let tokens = try await exchange(code: code, pkce: pkce, credentials: credentials)
        tokenManager.adopt(tokens)
    }

    /// Presents the web sheet and resolves with the callback URL's `code`.
    private func requestAuthorizationCode(url: URL, callbackScheme: String, expectedState: String) async throws -> String {
        let code = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            let webSession = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callbackURL, error in
                if let error {
                    // ASWebAuthenticationSessionError.canceledLogin = the user
                    // closed the sheet; surface as cancellation, not a fault.
                    continuation.resume(throwing: error)
                    return
                }
                guard let callbackURL,
                      let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                      let returnedState = components.queryItems?.first(where: { $0.name == "state" })?.value,
                      returnedState == expectedState else {
                    continuation.resume(throwing: GmailAPIError.transport("OAuth callback missing or mismatched state"))
                    return
                }
                guard let code = components.queryItems?.first(where: { $0.name == "code" })?.value else {
                    let errorDescription = components.queryItems?.first(where: { $0.name == "error" })?.value
                    continuation.resume(throwing: GmailAPIError.transport("OAuth callback error: \(errorDescription ?? "no code")"))
                    return
                }
                continuation.resume(returning: code)
            }
            webSession.presentationContextProvider = self
            webSession.prefersEphemeralWebBrowserSession = true
            webSession.start()
            self.activeWebSession = webSession
        }
        activeWebSession = nil
        return code
    }

    /// Exchanges the authorization code for tokens (the only network call that
    /// carries the PKCE verifier or the optional client secret).
    private func exchange(code: String, pkce: PKCE, credentials: GmailCredentials) async throws -> TokenSet {
        var form = [
            "code": code,
            "client_id": credentials.clientID,
            "redirect_uri": credentials.redirectURI,
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

    // MARK: ASWebAuthenticationPresentationContextProviding

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.mainWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
    }
}

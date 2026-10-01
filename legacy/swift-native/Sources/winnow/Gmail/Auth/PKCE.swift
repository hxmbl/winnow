import CryptoKit
import Foundation

/// PKCE (RFC 7636) code verifier/challenge pair for the Authorization Code
/// flow.
///
/// SECURITY MODEL
/// - The verifier is 32 bytes from `SecRandomCopyBytes` (cryptographically
///   secure RNG), base64url-encoded to the spec's 43-character minimum.
/// - Only the *challenge* (SHA-256 of the verifier) travels in the authorize
///   URL. The verifier is held in memory and sent solely to Google's token
///   endpoint at exchange time, so an intercepted authorize URL cannot be
///   replayed to redeem the code.
struct PKCE: Equatable {
    let verifier: String
    let challenge: String

    /// Fresh, cryptographically random pair for a new sign-in.
    init() {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed: \(status)")
        self.init(verifier: Self.base64url(Data(bytes)))
    }

    /// Deterministic pair — also the path for the RFC 7636 test vector.
    init(verifier: String) {
        self.verifier = verifier
        let digest = SHA256.hash(data: Data(verifier.utf8))
        self.challenge = Self.base64url(Data(digest))
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

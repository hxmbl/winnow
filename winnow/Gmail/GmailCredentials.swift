import Foundation

/// OAuth client credentials for the Gmail API.
///
/// SECURITY MODEL
/// - The real plist (`winnow/GmailCredentials.plist`) is **git-ignored**; only
///   `GmailCredentials.example.plist` is committed. Credentials never enter
///   version control or the source tree history.
/// - This is an *installed-app* flow: per Google's OAuth spec the client secret
///   is not confidential, so `ClientSecret` is optional and PKCE (S256) is
///   always used. The secret, if present, is sent only to Google's token
///   endpoint over HTTPS and stored nowhere else.
/// - No credential value is ever logged.
///
/// Absent credentials are not an error condition for the app — `WinnowStore`
/// falls back to demo mode — but calling `load()` when setup hasn't happened
/// throws a descriptive error so misconfiguration is obvious.
struct GmailCredentials: Equatable {
    let clientID: String
    let clientSecret: String?

    static let resourceName = "GmailCredentials"

    /// Loads credentials from a plist in `bundle`. Throws `GmailConfigError`
    /// with actionable copy when the file is missing or malformed.
    static func load(bundle: Bundle = .main) throws -> GmailCredentials {
        guard let url = bundle.url(forResource: Self.resourceName, withExtension: "plist") else {
            throw GmailConfigError.missing
        }
        let data = try Data(contentsOf: url)
        return try Self(plistData: data)
    }

    /// Testable core: parse from raw plist bytes.
    init(plistData: Data) throws {
        guard let dict = try PropertyListSerialization.propertyList(
            from: plistData, options: [], format: nil
        ) as? [String: Any] else {
            throw GmailConfigError.malformed
        }
        let id = (dict["ClientID"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !id.isEmpty, !id.hasPrefix("YOUR-CLIENT-ID") else {
            throw GmailConfigError.malformed
        }
        let secret = (dict["ClientSecret"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.clientID = id
        self.clientSecret = secret.isEmpty || secret.hasPrefix("OPTIONAL") ? nil : secret
    }

    /// Google's convention for installed apps: the redirect URI is the client
    /// ID reversed plus a path, e.g. `123-abc.apps.googleusercontent.com`
    /// → `com.googleusercontent.apps.123-abc:/oauthredirect`.
    /// Deriving it here means setup only ever involves pasting the client ID.
    var redirectURI: String {
        "com.googleusercontent.apps." + clientID + ":/oauthredirect"
    }

    /// The custom scheme part of the redirect URI — what
    /// `ASWebAuthenticationSession` listens for.
    var callbackScheme: String {
        String(redirectURI.split(separator: ":").first ?? "")
    }

    /// One scope, on purpose: `gmail.modify` covers read, star (STARRED label),
    /// archive, trash, and send. Broader scopes (`gmail.full_access`? none) and
    /// narrower ones (`gmail.readonly`) would each break an M1 capability.
    /// Fewer scopes = smaller consent screen = smaller blast radius.
    static let scope = "https://www.googleapis.com/auth/gmail.modify"
}

enum GmailConfigError: LocalizedError, Equatable {
    case missing
    case malformed
    case keychain(OSStatus)
    /// The stored refresh token is gone or was rejected (revoked, password
    /// change, dormancy). The only fix is a fresh interactive sign-in.
    case reauthRequired

    var errorDescription: String? {
        switch self {
        case .missing:
            return "No GmailCredentials.plist found. Copy winnow/GmailCredentials.example.plist to winnow/GmailCredentials.plist and paste your OAuth client ID."
        case .malformed:
            return "GmailCredentials.plist exists but the ClientID is missing or still a placeholder."
        case .keychain(let status):
            return "Keychain operation failed with OSStatus \(status). If this persists, remove the stale item via Keychain Access (service: com.stormofthoughts.winnow.gmail)."
        case .reauthRequired:
            return "Your Google session has expired or was revoked. Sign in again to reconnect."
        }
    }
}

import Foundation
import Security

/// A Google-issued OAuth token bundle.
///
/// SECURITY MODEL
/// - Persisted **only** in the login Keychain (`KeychainTokenStore`), never in
///   UserDefaults — UserDefaults is a plain plist on disk, readable by anything
///   with the user's file access; Keychain items are encrypted and ACL-scoped.
/// - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: available after the
///   first login, and explicitly *excluded* from iCloud Keychain sync so a
///   Gmail token never leaves this machine.
/// - `refreshToken` is the long-lived secret; losing it just means the user
///   signs in again, so the store prefers under-retention over over-retention.
struct TokenSet: Codable, Equatable {
    var accessToken: String
    var refreshToken: String?
    var expiresAt: Date
    var scope: String?
}

/// Persistence seam for `TokenSet`. MainActor-scoped: this is single-user,
/// foreground-app state, and one isolation domain keeps the audit simple.
protocol TokenStore: Sendable {
    func load() throws -> TokenSet?
    func save(_ tokens: TokenSet) throws
    func clear() throws
}

/// Real storage: the macOS login Keychain.
///
/// One generic-password item per service name. The whole `TokenSet` is stored
/// as one JSON blob under one ACL — simpler to audit than field-per-item, and
/// reads/writes are atomic.
struct KeychainTokenStore: TokenStore {
    let service: String
    let account: String

    init(service: String = "com.stormofthoughts.winnow.gmail", account: String = "oauth") {
        self.service = service
        self.account = account
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

    func load() throws -> TokenSet? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw GmailConfigError.keychain(status) }
        guard let data = result as? Data else { throw GmailConfigError.keychain(errSecParam) }
        return try JSONDecoder().decode(TokenSet.self, from: data)
    }

    func save(_ tokens: TokenSet) throws {
        let data = try JSONEncoder().encode(tokens)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // This-device-only: tokens must not silently replicate via iCloud
            // Keychain to other machines.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]

        let updateStatus = SecItemUpdate(baseQuery() as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var add = baseQuery()
            for (key, value) in attributes { add[key] = value }
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw GmailConfigError.keychain(addStatus) }
        } else if updateStatus != errSecSuccess {
            throw GmailConfigError.keychain(updateStatus)
        }
    }

    func clear() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        // Deleting a non-existent item is success for our purposes.
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw GmailConfigError.keychain(status)
        }
    }
}

/// Ephemeral storage for unit tests and previews. Never touches disk.
@MainActor
final class InMemoryTokenStore: TokenStore {
    private var tokens: TokenSet?
    private(set) var saveCount = 0
    private(set) var clearCount = 0

    nonisolated init() {}

    func load() throws -> TokenSet? { tokens }
    func save(_ tokens: TokenSet) throws { self.tokens = tokens; saveCount += 1 }
    func clear() throws { tokens = nil; clearCount += 1 }
}

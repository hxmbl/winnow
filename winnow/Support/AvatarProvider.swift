import CryptoKit
import Foundation

/// Supplies the remote avatar URL for a mail sender. Kept behind a protocol so
/// the fetch behavior (Gravatar today, others later) is easy to swap and to
/// unit-test the URL construction without a network hit.
protocol AvatarProviding {
    func avatarURL(for sender: String, size: Int) -> URL?
}

/// Gravatar resolution: the sender's email address (extracted from the display
/// string) is trimmed, lowercased, and MD5-hashed exactly per Gravatar's
/// spec. `d=404` makes unknown accounts render as HTTP 404 instead of the
/// default pixel avatar, so the reader falls back to initials; `r=g` keeps it
/// to the public rating.
struct GravatarAvatarProvider: AvatarProviding {
    static let shared = GravatarAvatarProvider()

    func avatarURL(for sender: String, size: Int) -> URL? {
        guard let email = Self.email(in: sender) else { return nil }
        let normalized = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let digest = Insecure.MD5.hash(data: Data(normalized.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return URL(string: "https://www.gravatar.com/avatar/\(hex)?s=\(size)&d=404&r=g")
    }

    /// Pulls a plausible email address out of a "Display Name <addr@x.com>"
    /// or bare "addr@x.com" sender string. `nil` for display-only senders —
    /// those get the initials fallback instead.
    static func email(in text: String) -> String? {
        guard let range = text.range(of: #"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"#, options: .regularExpression) else {
            return nil
        }
        return String(text[range])
    }
}

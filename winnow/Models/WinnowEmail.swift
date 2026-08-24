import Foundation

/// A single inbox email thread.
struct WinnowEmail: Identifiable, Equatable {
    let id: Int
    let sender: String
    var name: String?
    var email: String?

    /// Arrival time as Unix milliseconds — the source of truth for date sorting.
    let receivedAt: Int

    let subject: String
    let body: String

    /// Freeform source label. Only three values affect classification —
    /// `"newsletter"`, `"security"`, and `"promotional"` force their signal on;
    /// all others are ignored by the rule engine.
    let type: String

    /// Mutable so starring/unstarring from the UI can feed the learning loop.
    var starred: Bool

    /// Sender/server-supplied urgency bit; bypasses the urgency text heuristics.
    let urgent: Bool

    /// Name to display: the friendly `name` when present, otherwise the local
    /// part of the sender address (e.g. "alex" from "alex@winnow.app").
    var displayName: String {
        if let name, !name.isEmpty { return name }
        if sender.contains("@") {
            return String(sender.split(separator: "@").first ?? "")
        }
        return sender
    }

    /// Address shown under the display name: the friendly address when present,
    /// otherwise the raw sender string.
    var displayAddress: String {
        email ?? sender
    }
}

/// A trashed email. Only the sender is kept — it feeds the per-sender trash bias
/// used when building the user profile.
struct TrashRow: Identifiable {
    let id = UUID()
    let sender: String

    nonisolated init(sender: String) {
        self.sender = sender
    }
}

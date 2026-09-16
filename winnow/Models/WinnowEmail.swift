import Foundation

/// One attachment on a Gmail message. The payload is not downloaded until the
/// user asks — only the metadata travels with the email.
struct EmailAttachment: Identifiable, Equatable, Codable {
    let id: String          // Gmail attachmentId — what the API fetch needs.
    let partId: String
    let filename: String
    let mimeType: String
    let size: Int
}

/// The mailbox a message currently belongs to. Gmail negotiation: `TRASH`
/// dominates, then `INBOX`; anything else is archived (All Mail minus those).
enum EmailMailbox: String, Codable, CaseIterable {
    case inbox, archive, trash
}

/// A single email thread in the user's mailbox.
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

    /// Read state: true while the `UNREAD` label is set. Flipped by opening a
    /// message. Defaults to read so existing construction sites (mock data)
    /// have no new decision to make.
    var unread = false

    /// The original `text/html` body when the message had one (kept for the
    /// reader's fidelity; never rendered as markup — always stripped to text).
    var bodyHTML: String?

    /// Attachments carried by this message (metadata only).
    var attachments: [EmailAttachment] = []

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

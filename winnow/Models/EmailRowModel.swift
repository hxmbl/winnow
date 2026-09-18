import Foundation

/// A ready-to-render inbox row: the email paired with its cached classification,
/// so list rendering never re-runs the rule engine.
struct EmailRowModel: Identifiable {
    let email: WinnowEmail
    let sig: EmailSignals

    var id: Int { email.id }
}

/// One row in a conversation-aware list: a thread's messages grouped into a
/// single row. Messages live oldest → newest; the representative (what the row
/// displays and triage opens) is the newest message.
struct EmailThreadRow: Identifiable {
    /// Oldest → newest messages sharing one Gmail thread.
    let messages: [WinnowEmail]

    /// Keyed by the newest message, so cursor/open bookkeeping keeps working.
    var id: Int { representative.id }

    /// The newest message — what the row shows and the reader focuses.
    var representative: WinnowEmail {
        messages[messages.count - 1]
    }

    /// Total messages in the conversation (row count == 1 for standalone mail).
    var conversationCount: Int { messages.count }

    func contains(_ id: Int) -> Bool {
        messages.contains { $0.id == id }
    }
}

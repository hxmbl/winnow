import Foundation

/// Mailboxes selectable from the bottom-left pill. Archive and Trash list real
/// Gmail mail in live mode; in demo mode they are empty placeholders.
enum Mailbox: String, CaseIterable {
    case inbox, archive, trash

    var label: String {
        switch self {
        case .inbox: return "Inbox"
        case .archive: return "Archive"
        case .trash: return "Trash"
        }
    }

    var icon: String {
        switch self {
        case .inbox: return "tray"
        case .archive: return "archivebox"
        case .trash: return "trash"
        }
    }

    /// The cache bucket this mailbox reads from. `EmailMailbox` is the on-disk
    /// truth; this is the view-level label for the same three rows.
    var emailMailbox: EmailMailbox {
        switch self {
        case .inbox: return .inbox
        case .archive: return .archive
        case .trash: return .trash
        }
    }
}
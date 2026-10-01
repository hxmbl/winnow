import Foundation

/// Mailboxes selectable from the bottom-left pill. Archive, Trash, and Spam
/// list real Gmail mail in live mode; in demo mode they are empty placeholders.
enum Mailbox: String, CaseIterable {
    case inbox, archive, trash, spam

    var label: String {
        switch self {
        case .inbox: return "Inbox"
        case .archive: return "Archive"
        case .trash: return "Trash"
        case .spam: return "Spam"
        }
    }

    var icon: String {
        switch self {
        case .inbox: return "tray"
        case .archive: return "archivebox"
        case .trash: return "trash"
        case .spam: return "exclamationmark.triangle"
        }
    }

    /// The cache bucket this mailbox reads from. `EmailMailbox` is the on-disk
    /// truth; this is the view-level label for the same rows.
    var emailMailbox: EmailMailbox {
        switch self {
        case .inbox: return .inbox
        case .archive: return .archive
        case .trash: return .trash
        case .spam: return .spam
        }
    }
}

/// The destinations reachable from the compact navigation palette (`!`):
/// the three mailboxes plus Settings. Keyboard-driven, one axis (arrows/`j`/`k`
/// move, ⏎/`o`/`!` activate or dismiss).
enum NavigationItem: String, CaseIterable, Identifiable {
    case inbox, spam, trash, settings

    var id: String { rawValue }

    var label: String {
        switch self {
        case .inbox: return "Inbox"
        case .spam: return "Spam"
        case .trash: return "Bin / Trash"
        case .settings: return "Settings"
        }
    }

    var icon: String {
        switch self {
        case .inbox: return "tray"
        case .spam: return "exclamationmark.triangle"
        case .trash: return "trash"
        case .settings: return "gearshape"
        }
    }

    /// The mailbox this item switches to; `nil` for Settings (its own window).
    var mailbox: Mailbox? {
        switch self {
        case .inbox: return .inbox
        case .spam: return .spam
        case .trash: return .trash
        case .settings: return nil
        }
    }

    /// Which palette index the current mailbox maps to, for highlight syncing.
    static func index(for mailbox: Mailbox) -> Int {
        switch mailbox {
        case .inbox: return allCases.firstIndex(of: .inbox) ?? 0
        case .spam: return allCases.firstIndex(of: .spam) ?? 0
        case .trash: return allCases.firstIndex(of: .trash) ?? 0
        case .archive: return 0
        }
    }
}

import Foundation

/// Semantic buckets the app can filter by, without naming individual vendors.
enum BuiltinSmartFilter: String, CaseIterable {
    case starred
    case important
    case urgent
    case security
    case needsAction = "needs_action"
    case receipts
    case newsletters
    case promotional
    case lowPriority = "low_priority"
    case unsafe
    case topContacts = "top_contacts"
    case quietContacts = "quiet_contacts"
}

/// Identifies a filter: either a built-in bucket or a specific sender.
enum FilterId: Hashable, Identifiable {
    case builtin(BuiltinSmartFilter)
    case sender(String)

    var id: String {
        switch self {
        case .builtin(let filter): return filter.rawValue
        case .sender(let sender): return "sender:\(sender)"
        }
    }

    /// `true` for the "Unsafe" bucket, which is exclusive (see `WinnowStore.toggleFilter`).
    var isUnsafe: Bool {
        if case .builtin(.unsafe) = self { return true }
        return false
    }
}

import Foundation

/// Sort orders offered in the toolbar picker.
enum SortBy: String, CaseIterable, Identifiable {
    case date
    case sender
    case score

    var id: String { rawValue }

    /// Human-readable label shown in the sort menu.
    var label: String {
        switch self {
        case .date: return "Date"
        case .sender: return "Sender"
        case .score: return "Smart Score"
        }
    }
}

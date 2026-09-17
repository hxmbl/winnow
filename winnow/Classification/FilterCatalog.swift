import Foundation

/// One entry of the pill rail: a built-in bucket plus its display label.
struct BuiltinFilter: Identifiable, Equatable {
    let id: BuiltinSmartFilter
    let label: String
}

/// Canonical filter set shown in the bottom rail. The rail's live ordering is
/// produced by `rankFilters` and cached in `WinnowStore.railItems`.
nonisolated let builtinFilters: [BuiltinFilter] = [
    BuiltinFilter(id: .important, label: "Important"),
    BuiltinFilter(id: .urgent, label: "Urgent"),
    BuiltinFilter(id: .needsAction, label: "Action needed"),
    BuiltinFilter(id: .security, label: "Security"),
    BuiltinFilter(id: .receipts, label: "Receipts"),
    BuiltinFilter(id: .starred, label: "Starred"),
    BuiltinFilter(id: .topContacts, label: "Top contacts"),
    BuiltinFilter(id: .quietContacts, label: "Quiet contacts"),
    BuiltinFilter(id: .newsletters, label: "Newsletters"),
    BuiltinFilter(id: .promotional, label: "Promos"),
    BuiltinFilter(id: .lowPriority, label: "Read later"),
    BuiltinFilter(id: .unsafe, label: "Unsafe"),
]

extension BuiltinSmartFilter {
    /// Human label from the canonical filter set (fallback: raw value).
    var label: String {
        builtinFilters.first(where: { $0.id == self })?.label ?? rawValue
    }
}

/// Array-position wrapper keeping the rail's items stable as it re-ranks.
struct FilterRailItem: Identifiable {
    let id: Int
    let filter: BuiltinFilter
}

/// Builds the rail's item list from a ranked filter set, one item per filter.
enum FilterRailLayout {
    static func items(from ranked: [BuiltinFilter]) -> [FilterRailItem] {
        ranked.enumerated().map { FilterRailItem(id: $0.offset, filter: $0.element) }
    }
}

/// Static group ordering — high-signal → engagement → noise → safety. Within a
/// group, filters are ordered by how many inbox emails they currently match.
nonisolated private let filterGroup: [BuiltinSmartFilter: Int] = [
    .important: 0, .urgent: 0, .needsAction: 0, .security: 0,
    .starred: 1, .receipts: 1, .topContacts: 1, .quietContacts: 1,
    .newsletters: 2, .promotional: 2, .lowPriority: 2,
    .unsafe: 3,
]

/// Orders filters for display: group order first, then by current match count
/// within the inbox. Consumes already-cached signals so ranking the rail never
/// re-runs the classifier. Pure function over the given inputs.
nonisolated func rankFilters(
    inbox: [WinnowEmail],
    signals: [Int: EmailSignals],
    profile: UserProfile
) -> [BuiltinFilter] {
    var counts: [BuiltinSmartFilter: Int] = [:]
    for filter in builtinFilters { counts[filter.id] = 0 }
    for email in inbox {
        guard let sig = signals[email.id], !sig.isUnsafe else { continue }
        for filter in builtinFilters where matchesBuiltin(filter.id, email: email, sig: sig, profile: profile) {
            counts[filter.id, default: 0] += 1
        }
    }

    return builtinFilters.sorted { a, b in
        let groupA = filterGroup[a.id] ?? 99
        let groupB = filterGroup[b.id] ?? 99
        if groupA != groupB { return groupA < groupB }
        let countA = counts[a.id] ?? 0
        let countB = counts[b.id] ?? 0
        if countA != countB { return countA > countB }
        return a.id.rawValue < b.id.rawValue
    }
}

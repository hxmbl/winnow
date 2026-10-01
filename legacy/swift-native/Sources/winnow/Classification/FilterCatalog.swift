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
    BuiltinFilter(id: .codes, label: "Codes"),
    BuiltinFilter(id: .shipping, label: "Deliveries"),
    BuiltinFilter(id: .travel, label: "Travel"),
    BuiltinFilter(id: .events, label: "Events"),
    BuiltinFilter(id: .receipts, label: "Receipts"),
    BuiltinFilter(id: .starred, label: "Starred"),
    BuiltinFilter(id: .unread, label: "Unread"),
    BuiltinFilter(id: .attachments, label: "Files"),
    BuiltinFilter(id: .newSenders, label: "New contacts"),
    BuiltinFilter(id: .topContacts, label: "Top contacts"),
    BuiltinFilter(id: .quietContacts, label: "Quiet contacts"),
    BuiltinFilter(id: .newsletters, label: "Newsletters"),
    BuiltinFilter(id: .promotional, label: "Promos"),
    BuiltinFilter(id: .lowPriority, label: "Read later"),
    BuiltinFilter(id: .longReads, label: "Long reads"),
    BuiltinFilter(id: .social, label: "Social"),
    BuiltinFilter(id: .unsafe, label: "Unsafe")
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

/// Buckets pinned to the front of the rail no matter how much mail they
/// currently match — the always-watch buckets. Everything else ranks as a
/// "magic" bucket: it only appears while it has mail, bubbling up by volume.
nonisolated let permanentFilterIds: [BuiltinSmartFilter] = [.important, .shipping]

/// Orders the rail for display: permanent buckets first, then — ranked by how
/// many inbox emails they currently match, empties hidden — the remaining
/// buckets, and the exclusive Unsafe safety-valve pinned last. Consumes
/// already-cached signals so ranking never re-runs the classifier. Pure
/// function over the given inputs.
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

    let byCatalogIndex: (BuiltinSmartFilter) -> Int = { id in
        builtinFilters.firstIndex { $0.id == id } ?? builtinFilters.count
    }
    let pinned: [BuiltinFilter] = permanentFilterIds.compactMap { id in
        builtinFilters.first { $0.id == id }
    }

    // The "magic" buckets: everything else with mail in it right now, ordered
    // by how much they currently catch so the busiest buckets surface first.
    let magic = builtinFilters
        .filter { !permanentFilterIds.contains($0.id) && $0.id != .unsafe }
        .filter { (counts[$0.id] ?? 0) > 0 }
        .sorted { lhs, rhs in
            let countLHS = counts[lhs.id] ?? 0
            let countRHS = counts[rhs.id] ?? 0
            if countLHS != countRHS { return countLHS > countRHS }
            return byCatalogIndex(lhs.id) < byCatalogIndex(rhs.id)
        }

    let unsafe = builtinFilters.first { $0.id == .unsafe }
    return pinned + magic + [unsafe].compactMap { $0 }
}

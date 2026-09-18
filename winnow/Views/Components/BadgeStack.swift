import SwiftUI

/// Small status icons shown at the right of each row / viewer header.
/// Like the star, every indicator is tappable: tapping one toggles its smart
/// filter bucket on or off. The star itself stars/unstars this email.
struct BadgeStack: View {
    let sig: EmailSignals
    let starred: Bool
    var onToggleStar: () -> Void = {}
    /// Buckets whose filter pills are currently active (drives the checkmark).
    var activeFilters: [FilterId] = []
    var onToggleFilter: (BuiltinSmartFilter) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 8) {
            ForEach(sig.rowIndicators, id: \.self) { filter in
                Button { onToggleFilter(filter) } label: {
                    HStack(spacing: 2) {
                        Image(systemName: filter.iconName)
                            .foregroundStyle(color(for: filter))
                        if activeFilters.contains(.builtin(filter)) {
                            Image(systemName: "checkmark")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(4)
                .background(
                    activeFilters.contains(.builtin(filter))
                        ? Color.accentColor.opacity(0.10)
                        : Color.clear,
                    in: RoundedRectangle(cornerRadius: 5, style: .continuous)
                )
                .accessibilityLabel(activeFilters.contains(.builtin(filter)) ? "\(filter.label) filter, on" : "\(filter.label) filter")
                .help("Toggle \(filter.label) filter")
            }
            Button(action: onToggleStar) {
                Image(systemName: starred ? "star.fill" : "star")
                    .foregroundStyle(starred ? Color.yellow : Color.winnowSecondary)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(4)
            .background(starred ? Color.yellow.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .accessibilityLabel(starred ? "Remove star" : "Add star")
            .help(starred ? "Remove star" : "Add star")
        }
        .font(.body)
        .imageScale(.medium)
    }

    /// Row icons keep their flat accent colors — palettes are for tinted pills.
    private func color(for filter: BuiltinSmartFilter) -> Color {
        switch filter {
        case .important, .unsafe: return .orange
        case .urgent: return .pink
        case .security: return .cyan
        case .newsletters: return .secondary
        case .promotional: return .green
        case .codes: return .pink
        case .shipping: return .green
        case .travel: return .cyan
        case .events: return .purple
        case .social: return .blue
        default: return .secondary
        }
    }
}

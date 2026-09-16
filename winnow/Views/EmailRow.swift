import SwiftUI

/// A single inbox list row.
struct EmailRow: View {
    let email: WinnowEmail
    let sig: EmailSignals
    /// Tapped by the star button; the row itself is opened via tap elsewhere.
    var onToggleStar: () -> Void = {}
    /// Buckets whose filter pills are currently active (drives badge checkmarks).
    var activeFilters: [FilterId] = []
    /// Tapped by any smart-filter indicator badge; toggles that bucket's filter.
    var onToggleFilter: (BuiltinSmartFilter) -> Void = { _ in }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Unread dot: a full-diameter accent dot, faded to near-invisible
            // once read — triage wants the eye to find what's new.
            Circle()
                .fill(email.unread ? Color.accentColor : Color.clear)
                .frame(width: 7, height: 7)
                .padding(.top, 15)
            AvatarView(sender: email.sender, size: 36, font: .subheadline)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(email.displayName)
                            .font(titleFont)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Text(email.displayAddress)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(formatListTime(email.receivedAt))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                        BadgeStack(
                            sig: sig,
                            starred: email.starred,
                            onToggleStar: onToggleStar,
                            activeFilters: activeFilters,
                            onToggleFilter: onToggleFilter
                        )
                    }
                }
                Text(email.subject)
                    .font(email.unread ? .subheadline.weight(.semibold) : .subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(email.body)
                    .font(email.unread ? .footnote.weight(.medium) : .subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 8)
    }

    private var titleFont: Font {
        email.unread ? .headline : .body.weight(.semibold)
    }
}

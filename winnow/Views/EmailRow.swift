import SwiftUI

/// A single inbox list row. When the row represents a conversation (`count >
    /// 1`) a small count chip prefixes the subject so thread density is legible
    /// without opening the reader.
    struct EmailRow: View {
        let email: WinnowEmail
        let sig: EmailSignals
        /// Messages in the same thread (1 for standalone mail).
        var conversationCount: Int = 1
        /// Tapped by the star button; the row itself is opened via tap elsewhere.
        var onToggleStar: () -> Void = {}
        /// Buckets whose filter pills are currently active (drives badge checkmarks).
        var activeFilters: [FilterId] = []
        /// Tapped by any smart-filter indicator badge; toggles that bucket's filter.
        var onToggleFilter: (BuiltinSmartFilter) -> Void = { _ in }
        /// Buckets the user silenced (STO-138) — passed to the badge stack.
        var removedFilters: Set<BuiltinSmartFilter> = []
        @State private var isHovered = false

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
                            onToggleFilter: onToggleFilter,
                            removedFilters: removedFilters
                        )
                    }
                }
                HStack(spacing: 6) {
                    if conversationCount > 1 {
                        Text("\(conversationCount)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.primary.opacity(0.06)))
                    }
                    Text(email.subject)
                        .font(email.unread ? .subheadline.weight(.semibold) : .subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
                Text(email.body)
                    .font(email.unread ? .footnote.weight(.medium) : .subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
        .background {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(isHovered ? Color.primary.opacity(0.055) : Color.clear)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(isHovered ? Color.winnowBorder.opacity(0.7) : Color.clear, lineWidth: 1)
        }
        .animation(.easeOut(duration: 0.12), value: isHovered)
    }

    private var titleFont: Font {
        email.unread ? .headline : .body.weight(.semibold)
    }
}

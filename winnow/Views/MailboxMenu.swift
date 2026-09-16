import SwiftUI

/// The fixed mailbox pill at the leading edge of the filter rail, with a
/// custom iOS-style pull-up card menu. Owns its own open/hover state; the
/// caller only binds the selection.
struct MailboxMenu: View {
    @Binding var selection: Mailbox

    @State private var isExpanded = false
    @State private var hoveredMailbox: Mailbox?

    var body: some View {
        menuButton
            // Scrim sits under the card and swallows every outside click
            .overlay {
                if isExpanded {
                    Rectangle()
                        .fill(Color.clear)
                        // Oversized so it covers the whole window; SwiftUI doesn't clip,
                        // and hit-testing still resolves gestures outside parent bounds.
                        .frame(width: 8000, height: 8000)
                        .contentShape(Rectangle())
                        .onTapGesture(perform: dismiss)
                }
            }
            // Card floats above the pill, its bottom edge parked just above the button;
            // alignmentGuide keeps it out of layout so the pill never shifts.
            .overlay(alignment: .top) {
                if isExpanded {
                    menuCard
                        .alignmentGuide(.top) { $0.height + 10 }
                        .transition(.pullUpFromButton)
                }
            }
            .help("Switch mailbox")
    }

    private var menuButton: some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                Image(systemName: selection.icon).imageScale(.small)
                Text(selection.label).font(.subheadline.weight(.semibold))
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.bold)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(Color(nsColor: .controlBackgroundColor), in: Capsule())
            .overlay(Capsule().stroke(Color.winnowBorder, lineWidth: 1))
            .foregroundStyle(.primary)
        }
        .buttonStyle(.plain)
    }

    /// The pull-up card: vibrancy material, continuous corners, hairline dividers —
    /// the same anatomy as a stock iOS pull-down/pull-up menu.
    private var menuCard: some View {
        VStack(spacing: 0) {
            ForEach(Array(Mailbox.allCases.enumerated()), id: \.element) { index, box in
                if index > 0 { Divider().opacity(0.7) }
                menuRow(box)
            }
        }
        .frame(width: 216)
        .fixedSize(horizontal: false, vertical: true)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(Color.winnowBorder.opacity(0.7), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.20), radius: 20, x: 0, y: 10)
    }

    private func menuRow(_ box: Mailbox) -> some View {
        let selected = selection == box
        return Button {
            select(box)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: box.icon)
                    .frame(width: 18)
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                Text(box.label)
                    .font(.subheadline.weight(selected ? .semibold : .regular))
                    .foregroundStyle(Color.primary)
                Spacer(minLength: 0)
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Color.accentColor)
                    .opacity(selected ? 1 : 0)
            }
            .padding(.horizontal, 14)
            .frame(height: 34)
            .contentShape(Rectangle())
            .background(hoveredMailbox == box ? Color.primary.opacity(0.06) : Color.clear)
        }
        .buttonStyle(.plain)
        .onHover { hovering in hoveredMailbox = hovering ? box : nil }
    }

    private func toggle() {
        withAnimation(.spring(duration: 0.35, bounce: 0.15)) { isExpanded.toggle() }
    }

    private func dismiss() {
        guard isExpanded else { return }
        withAnimation(.easeOut(duration: 0.15)) { isExpanded = false }
    }

    private func select(_ box: Mailbox) {
        withAnimation(.easeOut(duration: 0.15)) {
            selection = box
            isExpanded = false
        }
    }
}

// MARK: - Pull-up transition — springs out of the button's edge, iOS style

private extension AnyTransition {
    static var pullUpFromButton: AnyTransition {
        .asymmetric(
            insertion: .scale(scale: 0.5, anchor: .bottomLeading).combined(with: .opacity),
            removal: .scale(scale: 0.94, anchor: .bottomLeading).combined(with: .opacity)
        )
    }
}

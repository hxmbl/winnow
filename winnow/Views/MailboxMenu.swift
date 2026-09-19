import SwiftUI

/// STO-135 — fixed mailbox switcher at the leading edge of the filter rail.
///
/// Presents the choices as a native macOS popover: anchored to the pill,
/// contained inside the window, dismissed by outside click or Esc, and fully
/// keyboard-accessible. Unlike the earlier custom pull-up overlay this never
/// shifts the underlying layout, never positions itself across windows, and
/// keeps keyboard focus sane (the compact `!` palette and Settings are
/// unaffected). The caller only binds the selection.
struct MailboxMenu: View {
    @Binding var selection: Mailbox

    @State private var isExpanded = false
    @State private var hoveredMailbox: Mailbox?

    var body: some View {
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
        // Arrow on the pill's bottom edge ⇒ the card reads upward, matching
        // the layout of the old pull-up menu while staying native.
        .popover(isPresented: $isExpanded, arrowEdge: .bottom) {
            menuCard
        }
        .help("Switch mailbox")
    }

    /// The menu card: vibrancy material, continuous corners, hairline
    /// dividers — the same anatomy as a stock pull-down/pull-up menu.
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
        isExpanded.toggle()
    }

    private func select(_ box: Mailbox) {
        selection = box
        isExpanded = false
    }
}

import SwiftUI

/// A single rounded "pill" toggle. On = tinted with its filter palette; off = neutral.
struct PillButton: View {
    let label: String
    let iconName: String
    let palette: FilterPalette?
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if !iconName.isEmpty {
                    Image(systemName: iconName).imageScale(.small)
                }
                Text(label)
                if on {
                    Image(systemName: "checkmark")
                        .imageScale(.small)
                }
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(on ? (palette?.bg ?? Color.accentColor.opacity(0.2)) : Color.clear, in: Capsule())
            .overlay(Capsule().stroke(on ? (palette?.border ?? Color.accentColor) : Color.winnowBorder, lineWidth: 1))
            .foregroundStyle(on ? (palette?.text ?? Color.accentColor) : Color.winnowText)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label) filter")
        .accessibilityAddTraits(on ? [.isSelected] : [])
        .accessibilityHint("Toggles this smart filter")
    }
}

import SwiftUI

/// `?` overlay: every keybind, generated from `KeybindEngine.bindings` so the
/// documentation cannot drift from the routing table.
struct ShortcutSheet: View {
    @Bindable var store: WinnowStore

    var body: some View {
        ZStack {
            Rectangle()
                .fill(Color.black.opacity(0.28))
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { store.showShortcutOverlay = false }

            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Keyboard shortcuts")
                        .font(.headline)
                    Spacer()
                    Text("Esc to close")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 14)

                Divider().opacity(0.5)

                ForEach(Array(KeybindEngine.bindings.enumerated()), id: \.offset) { index, binding in
                    HStack(spacing: 14) {
                        Text(binding.display)
                            .font(.system(.callout, design: .monospaced).weight(.semibold))
                            .frame(minWidth: 64, alignment: .trailing)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color.winnowBackground, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(Color.winnowBorder, lineWidth: 1))
                        Text(binding.help)
                            .font(.callout)
                            .foregroundStyle(.primary)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 6)
                    if index < KeybindEngine.bindings.count - 1 {
                        Divider().opacity(0.25).padding(.leading, 20)
                    }
                }
            }
            .frame(width: 380)
            .background(Color.winnowCard)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.winnowBorder, lineWidth: 1))
            .shadow(color: .black.opacity(0.22), radius: 28, x: 0, y: 10)
            .padding(32)
        }
    }
}

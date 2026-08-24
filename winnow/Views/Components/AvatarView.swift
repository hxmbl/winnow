import SwiftUI

/// Circular initials avatar, tinted by a stable hash of the sender.
struct AvatarView: View {
    let sender: String
    let size: CGFloat
    let font: Font

    var body: some View {
        ZStack {
            Circle()
                .fill(avatarColor(sender))
                .frame(width: size, height: size)
            Text(String((sender.first ?? Character("?")).uppercased()))
                .font(font.weight(.bold))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}

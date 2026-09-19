import SwiftUI

/// Circular avatar. When the sender resolves to a Gravatar it is loaded
/// asynchronously (STO-133); otherwise — or while loading, or on 404 — the
/// initials fallback renders over the stable per-sender tint.
struct AvatarView: View {
    let sender: String
    let size: CGFloat
    let font: Font
    var provider: AvatarProviding = GravatarAvatarProvider.shared

    private var initials: some View {
        Text(String((sender.first ?? Character("?")).uppercased()))
            .font(font.weight(.bold))
            .foregroundStyle(.white)
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(avatarColor(sender))
            if let url = provider.avatarURL(for: sender, size: Int(size)) {
                AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
                    if case .success(let image) = phase {
                        image.resizable().scaledToFill()
                    } else {
                        initials
                    }
                }
                .clipShape(Circle())
            } else {
                initials
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}
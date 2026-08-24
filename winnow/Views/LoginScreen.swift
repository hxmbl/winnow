import SwiftUI

/// Sign-in screen. Tapping "Sign in with Google" proceeds to the mock inbox,
/// matching the pre-login demo behaviour. Real Gmail OAuth is not implemented.
struct LoginScreen: View {
    /// Called to start the (possibly live) sign-in; runs async in the store.
    let onSignIn: () -> Void
    /// Sign-in failure from the store, shown under the button.
    var errorMessage: String? = nil
    @State private var loading = false

    // MARK: - Body

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            VStack(spacing: 24) {
                ZStack {
                    RoundedRectangle(cornerRadius: 24)
                        .fill(LinearGradient(colors: [.blue, .blue.opacity(0.8)], startPoint: .topLeading, endPoint: .bottomTrailing))
                        .frame(width: 80, height: 80)
                        .shadow(color: .blue.opacity(0.3), radius: 16, y: 8)
                    Image(systemName: "paperplane.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.white)
                }
                VStack(spacing: 8) {
                    Text("Winnow")
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(Color.winnowText)
                    Text("Your inbox, intelligently sorted. Connect your Gmail to get started.")
                        .font(.subheadline)
                        .foregroundStyle(Color.winnowSecondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 280)
                }
                Button(action: { Task { await signIn() } }) {
                    HStack(spacing: 12) {
                        if loading {
                            ProgressView().controlSize(.small).tint(Color.winnowText)
                        } else {
                            googleMark
                        }
                        Text(loading ? "Connecting..." : "Sign in with Google")
                            .font(.headline)
                            .foregroundStyle(Color.winnowText)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Color.winnowCard)
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.winnowBorder, lineWidth: 1))
                    .shadow(color: .black.opacity(0.06), radius: 8, y: 4)
                }
                .buttonStyle(.plain)
                .disabled(loading)

                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 320)
                }

                Text("Winnow only reads your email to classify and sort it. Nothing is stored on external servers.")
                    .font(.caption)
                    .foregroundStyle(Color.winnowSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            }
            Spacer()
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.winnowBackground)
    }

    // MARK: - Subviews

    private var googleMark: some View {
        // Stand-in for the multicolor Google "G"; SwiftUI SF Symbol + tint.
        Image(systemName: "g.circle.fill")
            .font(.title3)
            .foregroundStyle(Color.blue)
    }

    // MARK: - Sign-in flow

    private func signIn() async {
        loading = true
        // Simulate the async handshake; no real OAuth is performed.
        try? await Task.sleep(nanoseconds: 400_000_000)
        onSignIn()
        loading = false
    }
}

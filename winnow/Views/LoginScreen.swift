import SwiftUI

/// Sign-in screen. Tapping "Sign in with Google" hands off to the store, whose
/// sign-in runs the real OAuth round-trip (or instant demo mode).
struct LoginScreen: View {
    /// Starts sign-in in the store. The button stays disabled until the store
    /// reports completion — a re-enable mid-flight would let a second click
    /// open a second browser tab.
    let onSignIn: () -> Void
    /// Cancels an in-flight sign-in; present only while one can be cancelled.
    var onCancelSignIn: (() -> Void)? = nil
    /// Sign-in failure from the store, shown under the button.
    var errorMessage: String? = nil
    /// True for the entire interactive sign-in (browser round-trip included).
    var isSigningIn = false

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
                Button(action: onSignIn) {
                    HStack(spacing: 12) {
                        if isSigningIn {
                            ProgressView().controlSize(.small).tint(Color.winnowText)
                        } else {
                            googleMark
                        }
                        Text(isSigningIn ? "Connecting..." : "Sign in with Google")
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
                .disabled(isSigningIn)

                if isSigningIn, let onCancelSignIn {
                    Button("Cancel", action: onCancelSignIn)
                        .buttonStyle(.plain)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.winnowSecondary)
                        .accessibilityIdentifier("cancel-sign-in")
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 320)
                        .textSelection(.enabled)
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
}

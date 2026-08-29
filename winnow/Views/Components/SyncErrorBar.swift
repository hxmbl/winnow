import SwiftUI

/// Slim failure strip under the toolbar: a background action (archive, trash,
/// star, refresh) failed server-side. Without this the failure was invisible
/// — `syncError` had no surface anywhere.
struct SyncErrorBar: View {
    let message: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
            Text(message)
                .font(.caption.weight(.medium))
                .lineLimit(2)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            Button(action: onDismiss) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss error")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .background(Color.winnowCard.opacity(0.95))
        .overlay(alignment: .bottom) { Divider().opacity(0.5) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sync-error-bar")
    }
}

#Preview {
    SyncErrorBar(message: "Gmail API returned HTTP 503.") {}
        .frame(width: 640)
}

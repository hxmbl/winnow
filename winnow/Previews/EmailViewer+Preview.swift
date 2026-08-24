#if DEBUG
import SwiftUI

private extension Array where Element == WinnowEmail {
    func previewEmail(_ id: Int) -> WinnowEmail {
        first { $0.id == id } ?? self[0]
    }
}

#Preview("Work message") {
    let store = WinnowStore.preview
    return ZStack {
        Rectangle()
            .fill(Color.black.opacity(0.28))
            .ignoresSafeArea()
        EmailViewer(email: store.inbox.previewEmail(48), store: store)
            .frame(maxWidth: 1000)
            .padding(32)
    }
}

#Preview("Security alert") {
    let store = WinnowStore.preview
    return ZStack {
        Rectangle()
            .fill(Color.black.opacity(0.28))
            .ignoresSafeArea()
        EmailViewer(email: store.inbox.previewEmail(20), store: store)
            .frame(maxWidth: 1000)
            .padding(32)
    }
}

#Preview("Security alert · Dark") {
    let store = WinnowStore.preview
    return ZStack {
        Rectangle()
            .fill(Color.black.opacity(0.28))
            .ignoresSafeArea()
        EmailViewer(email: store.inbox.previewEmail(20), store: store)
            .frame(maxWidth: 1000)
            .padding(32)
    }
    .preferredColorScheme(.dark)
}
#endif

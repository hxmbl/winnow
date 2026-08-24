#if DEBUG
import SwiftUI

#Preview("Inbox canvas") {
    ContentView(store: WinnowStore.preview)
}

#Preview("Filtered · Unsafe") {
    let store = WinnowStore.preview
    store.showUnsafe()
    return ContentView(store: store)
}

#Preview("Filter pills") {
    HStack(spacing: 8) {
        PillButton(
            label: "Important",
            iconName: BuiltinSmartFilter.important.iconName,
            palette: BuiltinSmartFilter.important.palette,
            on: true,
            action: {}
        )
        PillButton(
            label: "Receipts",
            iconName: BuiltinSmartFilter.receipts.iconName,
            palette: BuiltinSmartFilter.receipts.palette,
            on: false,
            action: {}
        )
        PillButton(
            label: "Unsafe",
            iconName: BuiltinSmartFilter.unsafe.iconName,
            palette: BuiltinSmartFilter.unsafe.palette,
            on: false,
            action: {}
        )
    }
    .padding(32)
}
#endif

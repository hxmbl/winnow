#if DEBUG
import SwiftUI

#Preview("Settings") {
    NavigationStack {
        SettingsView(store: WinnowStore.preview)
    }
}

#Preview("Settings · Dark") {
    NavigationStack {
        SettingsView(store: WinnowStore.preview)
    }
    .preferredColorScheme(.dark)
}
#endif

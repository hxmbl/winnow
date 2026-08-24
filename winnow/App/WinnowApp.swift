import SwiftUI

/// App entry point.
///
/// Owns the single shared `WinnowStore` and injects it into both scenes so the
/// main window and Settings always observe the same state.
@main
struct WinnowApp: App {

    // MARK: - State

    /// Single source of truth for auth, inbox data, filters, and appearance.
    @State private var store = WinnowStore()

    // MARK: - Scenes

    var body: some Scene {
        WindowGroup {
            ContentView(store: store)
        }
        .defaultSize(width: 1000, height: 700)
        .commands {
            CommandGroup(after: .appSettings) {
                Divider()
                Button("Sign Out") { store.signOut() }
                    .disabled(!store.authed)
            }
        }

        // Native Cmd-, preferences window; shares the store with the main scene.
        Settings {
            SettingsView(store: store)
        }
    }
}

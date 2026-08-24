import SwiftUI

/// Preferences window content. Uses a native `Form` and the macOS appearance
/// picker; "Unsafe emails" jumps to that smart mailbox in the main window.
struct SettingsView: View {
    @Bindable var store: WinnowStore

    // MARK: - Body

    var body: some View {
        Form {
            // MARK: Account (static demo identity)
            Section {
                HStack(spacing: 14) {
                    ZStack {
                        Circle()
                            .fill(LinearGradient(colors: [.blue, .blue.opacity(0.7)],
                                                 startPoint: .topLeading, endPoint: .bottomTrailing))
                            .frame(width: 44, height: 44)
                        Text("A").font(.title3.weight(.bold)).foregroundStyle(.white)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Alex Rivera").font(.headline).textSelection(.enabled)
                        Text("alex@winnow.app").font(.subheadline).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
            } header: {
                Text("Account")
            }

            // MARK: Preferences (appearance live; blocked senders + notifications are placeholders)
            Section {
                Picker("Appearance", selection: $store.appearance) {
                    ForEach(WinnowStore.Appearance.allCases) { appearance in
                        Text(appearance.label).tag(appearance)
                    }
                }
                HStack {
                    Label("Blocked senders", systemImage: "person.slash")
                    Spacer()
                    Text("Coming soon").foregroundStyle(.secondary)
                }
                HStack {
                    Label("Notifications", systemImage: "bell")
                    Spacer()
                    Text("Coming soon").foregroundStyle(.secondary)
                }
            } header: {
                Text("Preferences")
            }

            // MARK: Smart Inbox — user-tunable classification weights ("training")
            Section {
                Toggle(isOn: store.adaptiveLearningBinding()) {
                    Label("Adaptive learning", systemImage: "brain")
                }
                Text("Starring or unstarring mail nudges these weights automatically — the inbox learns what you care about.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                ForEach(SignalKey.allCases) { key in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(key.label)
                            Spacer()
                            if store.learning.adjustment(key) != 0 {
                                let delta = Int(store.learning.adjustment(key))
                                Text(delta > 0 ? "+\(delta)" : "\(delta)")
                                    .font(.caption.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(.orange)
                            }
                            Text("\(Int(store.learning.weight(key)))")
                                .font(.callout.monospacedDigit().weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                        Slider(value: store.learningWeightBinding(key), in: key.allowedRange, step: 1)
                        Text(key.explanation)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 2)
                }

                LabeledContent {
                    Button("Reset") { store.learning.resetAdjustments() }
                        .disabled(store.learning.weights == SignalWeights.standard)
                } label: {
                    Label("Learned adjustments", systemImage: "slider.horizontal.3")
                }
                LabeledContent {
                    Text("\(store.learning.events.count)").foregroundStyle(.secondary)
                } label: {
                    Label("Training examples", systemImage: "list.bullet.rectangle")
                }
            } header: {
                Text("Smart Inbox (ML)")
            }

            Section {
                HStack {
                    Label("Version", systemImage: "info.circle")
                    Spacer()
                    Text(displayVersion).foregroundStyle(.secondary)
                }
                Button {
                    store.showUnsafe()
                    NSApp.activate(ignoringOtherApps: true)
                } label: {
                    Label("View unsafe emails", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
            } header: {
                Text("About")
            }

            Section {
                Button(role: .destructive) {
                    store.signOut()
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .frame(width: 440, height: 720)
    }

    private var displayVersion: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        switch (short, build) {
        case let (.some(short), .some(build)) where short != build:
            return "\(short) (\(build))"
        case let (.some(short), _):
            return short
        default:
            return "—"
        }
    }
}

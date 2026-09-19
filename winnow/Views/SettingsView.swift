import SwiftUI

/// Preferences window content. Uses a native `Form` and the macOS appearance
/// picker; "Unsafe emails" jumps to that smart mailbox in the main window.
struct SettingsView: View {
    @Bindable var store: WinnowStore
    @State private var showSignOutConfirmation = false
    @State private var showResetConfirmation = false

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

            // MARK: Preferences — blocked senders + notifications (live)
            Section {
                Picker("Appearance", selection: $store.appearance) {
                    ForEach(WinnowStore.Appearance.allCases) { appearance in
                        Text(appearance.label).tag(appearance)
                    }
                }
                Toggle(isOn: $store.notificationsEnabled) {
                    Label("Notifications for new mail", systemImage: "bell")
                }
                Text("Winnow pings you when a refresh finds unread mail it hadn't shown yet (needs system notification permission).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let error = store.notificationError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                Toggle(isOn: $store.loadRemoteContent) {
                    Label("Load remote content in messages", systemImage: "photo")
                }
                Text("Off by default. Turning this on lets messages load remote images, styles and fonts, which tells senders when you opened their mail and can leak your IP address.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                NavigationLink {
                    BlockedSendersList(store: store)
                } label: {
                    LabeledContent {
                        Text("\(store.blockedSenders.count)").foregroundStyle(.secondary)
                    } label: {
                        Label("Blocked senders", systemImage: "person.slash")
                    }
                }
                NavigationLink {
                    RemovedFiltersList(store: store)
                } label: {
                    LabeledContent {
                        Text("\(store.removedFilters.count)").foregroundStyle(.secondary)
                    } label: {
                        Label("Hidden smart filters", systemImage: "eye.slash")
                    }
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
                    Button("Reset") { showResetConfirmation = true }
                        .disabled(store.learning.weights == SignalWeights.standard)
                        .confirmationDialog(
                            "Reset all learned adjustments?",
                            isPresented: $showResetConfirmation,
                            titleVisibility: .visible
                        ) {
                            Button("Reset", role: .destructive) {
                                store.learning.resetAdjustments()
                            }
                        } message: {
                            Text("This will reset all ML training weights to their defaults. This cannot be undone.")
                        }
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
                    NSApp.activate()
                } label: {
                    Label("View unsafe emails", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
            } header: {
                Text("About")
            }

            Section {
                Button(role: .destructive) {
                    showSignOutConfirmation = true
                } label: {
                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                }
                .confirmationDialog(
                    "Sign out of Winnow?",
                    isPresented: $showSignOutConfirmation,
                    titleVisibility: .visible
                ) {
                    Button("Sign out", role: .destructive) {
                        store.signOut()
                    }
                } message: {
                    Text("This will clear your authentication tokens and cached mail. You'll need to sign in again.")
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

/// Smart buckets the user silenced from the pill rail (STO-138). Removing a
/// filter hides that mail from the default inbox and retrains the learner
/// away from it; restoring here brings the pill and the mail back.
struct RemovedFiltersList: View {
    @Bindable var store: WinnowStore

    var body: some View {
        Group {
            if store.removedFilters.isEmpty {
                ContentUnavailableView(
                    "No hidden filters",
                    systemImage: "eye.slash",
                    description: Text("Right-click a smart filter in the rail and choose \u{201C}Hide\u{201D} to silence that bucket.")
                )
            } else {
                List {
                    ForEach(store.removedFilters.sorted { $0.rawValue < $1.rawValue }, id: \.self) { filter in
                        HStack(spacing: 12) {
                            Image(systemName: filter.iconName)
                                .font(.body)
                                .foregroundStyle(filter.palette.text)
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(filter.label).font(.body.weight(.medium))
                                Text("Hidden from the default inbox")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Restore") {
                                withAnimation { store.restoreFilter(filter) }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("Hidden Smart Filters")
    }
}

/// Blocked senders list. Blocking hides a sender's mail from every mailbox —
/// unblocking here brings it straight back (blocking is a view concern, the
/// cache still holds the messages).
struct BlockedSendersList: View {
    @Bindable var store: WinnowStore

    /// Best-effort display name for each blocked address, looked up from any
    /// mailbox still holding one of their messages.
    private func displayName(for sender: String) -> String {
        let all = store.inbox + store.archived + store.trashed
        return all.first { $0.sender == sender }?.displayName ?? sender
    }

    var body: some View {
        Group {
            if store.blockedSenders.isEmpty {
                ContentUnavailableView(
                    "No blocked senders",
                    systemImage: "person.slash",
                    description: Text("Block a sender from the message viewer to hide their mail.")
                )
            } else {
                List {
                    ForEach(store.blockedSenders.sorted(), id: \.self) { sender in
                        HStack(spacing: 12) {
                            AvatarView(sender: sender, size: 28, font: .caption)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(displayName(for: sender)).font(.body.weight(.medium))
                                Text(sender)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                            Spacer()
                            Button("Unblock") {
                                withAnimation { store.unblockSender(sender) }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("Blocked Senders")
    }
}

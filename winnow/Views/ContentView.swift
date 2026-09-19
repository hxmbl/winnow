import SwiftUI

/// Root view of the main window: login gate, email canvas, toolbar, and the
/// floating bottom filter rail with the fixed Inbox mailbox menu.
struct ContentView: View {
    @Bindable var store: WinnowStore
    @FocusState private var searchFocused: Bool
    @State private var keybinds: KeybindEngine?

    // MARK: - Body

    var body: some View {
        Group {
            if store.authed {
                NavigationStack {
                    canvasStack
                }
            } else {
                LoginScreen(
                    onSignIn: { store.startSignIn() },
                    onCancelSignIn: { store.cancelSignIn() },
                    errorMessage: store.lastAuthError,
                    isSigningIn: store.isSigningIn
                )
            }
        }
        .preferredColorScheme(store.chosenScheme)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay { emailPresentation }
        .overlay { shortcutOverlay }
        .overlay { navigationPalette }
        .background { keyboardShortcuts }
        // Keybinds are scoped to *this* window: the Settings scene must never
        // route `j/k` into the inbox.
        .background { MainWindowReader { window in attachKeybinds(to: window) } }
        .onChange(of: store.searchFocusToken) { _, _ in searchFocused = true }
        .onChange(of: store.settingsRequestToken) { _, _ in
            // Settings is its own scene (WindowGroup). `!` → Settings uses the
            // same selector the app menu's Preferences item does.
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        }
    }

    private func attachKeybinds(to window: NSWindow?) {
        guard let window else { return }
        if let engine = keybinds {
            engine.retarget(to: window)
        } else {
            let engine = KeybindEngine(store: store)
            engine.start(inWindow: window)
            keybinds = engine
        }
    }

    /// Modifier-combo shortcuts stay as hidden buttons (⌘F); single-key
    /// bindings live in `KeybindEngine`.
    private var keyboardShortcuts: some View {
        Group {
            Button("Find") { searchFocused = true }
                .keyboardShortcut("f", modifiers: .command)
        }
        .opacity(0)
        .accessibilityHidden(true)
    }

    /// Hands the hosting `NSWindow` to its callback once it exists (async, so
    /// state mutation never happens during view updates).
    private struct MainWindowReader: NSViewRepresentable {
        let onWindow: (NSWindow?) -> Void

        func makeNSView(context: Context) -> NSView {
            let view = NSView()
            DispatchQueue.main.async { [weak view] in
                onWindow(view?.window)
            }
            return view
        }

        func updateNSView(_ nsView: NSView, context: Context) {
            // STO-132: makeNSView's single tick can fire before the view has a
            // hosting window (launch-order races), leaving the keybind monitor
            // never installed — every key then plays the alert beep. Re-resolve
            // the window on each update so a transiently-windowless view is
            // caught as soon as its window exists, and a window that was
            // re-created re-targets the engine. Deferred like makeNSView so
            // state mutation never happens mid-update; attachKeybinds is
            // idempotent (re-target is a no-op on a nil or repeated window).
            DispatchQueue.main.async { [weak nsView] in
                onWindow(nsView?.window)
            }
        }
    }

    /// `?` cheat sheet — rendered from the engine's binding table, so it can
    /// never drift from actual behavior.
    @ViewBuilder
    private var shortcutOverlay: some View {
        if store.showShortcutOverlay {
            ShortcutSheet(store: store)
                .transition(.opacity.combined(with: .scale(scale: 0.97)))
        }
    }

    /// Compact navigation palette (`!`): Inbox · Spam · Bin · Settings, one
    /// axis, keyboard-driven. Floats above the rail's leading edge.
    @ViewBuilder
    private var navigationPalette: some View {
        if store.navigationVisible {
            VStack(spacing: 2) {
                ForEach(Array(NavigationItem.allCases.enumerated()), id: \.element.id) { index, item in
                    HStack(spacing: 10) {
                        Image(systemName: item.icon)
                            .font(.callout.weight(.medium))
                            .frame(width: 16)
                        Text(item.label)
                            .font(.callout.weight(index == store.navigationIndex ? .semibold : .regular))
                        Spacer(minLength: 20)
                        if index == store.navigationIndex {
                            Image(systemName: "return")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .foregroundStyle(index == store.navigationIndex ? Color.accentColor : Color.primary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                    .background {
                        if index == store.navigationIndex {
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(Color.accentColor.opacity(0.10))
                        }
                    }
                    .onTapGesture {
                        withAnimation(.easeOut(duration: 0.12)) { store.activateNavigation(at: index) }
                    }
                }
            }
            .padding(6)
            .background(Color.winnowCard, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.winnowBorder, lineWidth: 1))
            .shadow(color: .black.opacity(0.18), radius: 16, x: 0, y: 6)
            .padding(.leading, 12)
            .padding(.bottom, 56)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }

    // MARK: - Floating email card — dims the canvas, dismisses on outside click

    private var emailPresentation: some View {
        ZStack {
            if let email = store.selectedEmail {
                Rectangle()
                    .fill(Color.black.opacity(0.28))
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { dismissEmail() }
                EmailViewer(email: email, store: store)
                    .id(email.id)
                    // Two frames: cap width on large windows, stay fluid below.
                    .frame(maxWidth: 1000)
                    .frame(maxWidth: .infinity)
                    // Even margin around the card on all sides.
                    .padding(32)
                    .transition(.opacity.combined(with: .scale(scale: 0.97)))
                    .accessibilityAddTraits(.isModal)
            }
        }
        .animation(.easeOut(duration: 0.18), value: store.selectedEmailID)
    }

    private func dismissEmail() {
        withAnimation(.easeOut(duration: 0.18)) { store.dismissEmail() }
    }

    // MARK: - Canvas — fills entire window, spacious

    private var canvasStack: some View {
        ZStack(alignment: .bottom) {
            // The overlay floats; the canvas keeps its full layout space.
            emailCanvas
            bottomOverlay
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Picker("Sort by", systemImage: "arrow.up.arrow.down", selection: $store.sortBy) {
                    ForEach(SortBy.allCases) { sort in Text(sort.label).tag(sort) }
                }
                .pickerStyle(.menu)
                .help("Sort messages")
            }
            ToolbarItem {
                Button { Task { await store.refresh() } } label: {
                    if store.isRefreshing { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.clockwise") }
                }
                .keyboardShortcut("r", modifiers: .command)
                .help("Refresh inbox")
                .disabled(store.isRefreshing)
            }
        }
    }

    private var emailCanvas: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor).ignoresSafeArea()
            VStack(spacing: 0) {
                headerBar
                if let syncError = store.syncError {
                    SyncErrorBar(message: syncError) { store.dismissSyncError() }
                }
                Divider().opacity(0.5)
                emailList
            }
            if store.isRefreshing {
                VStack {
                    Spacer()
                    Label("Syncing mail…", systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(.regularMaterial, in: Capsule())
                        .overlay(Capsule().stroke(Color.winnowBorder, lineWidth: 1))
                        .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
                        .padding(.bottom, 58)
                }
                .transition(.opacity)
                .allowsHitTesting(false)
            }
        }
        .animation(.easeOut(duration: 0.16), value: store.isRefreshing)
    }

    private var bottomOverlay: some View {
        ZStack(alignment: .leading) {
            FilterRail(store: store)

            // Fixed mailbox menu — does NOT scroll, sits visually over the rail
            MailboxMenu(selection: $store.mailbox)
                .padding(.leading, 12)
                .background {
                    // subtle fade so rail appears to scroll underneath
                    HStack(spacing: 0) {
                        Rectangle().fill(.ultraThinMaterial).frame(width: 140)
                        LinearGradient(
                            colors: [Color(nsColor: .windowBackgroundColor).opacity(0.9), Color.clear],
                            startPoint: .leading, endPoint: .trailing
                        )
                        .frame(width: 20)
                    }
                }
        }
        .frame(height: 48)
        .frame(maxWidth: .infinity)
    }

    // MARK: - Header bar — title, clear-filters, search field

    private var headerBar: some View {
        HStack(spacing: 12) {
            Text(store.listTitle).font(.title3.weight(.bold)).foregroundStyle(.primary)
            if !store.activeFilters.isEmpty {
                Button("Clear") { withAnimation { store.clearAllFilters() } }
                    .font(.caption.weight(.medium)).buttonStyle(.plain).foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary).font(.caption)
                TextField("Search emails", text: $store.searchQuery)
                    .textFieldStyle(.plain).font(.subheadline).frame(width: 180)
                    .focused($searchFocused)
                    .accessibilityLabel("Search emails")
                if !store.searchQuery.isEmpty {
                    Button { store.searchQuery = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }.buttonStyle(.plain)
                        .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Color(nsColor: .controlBackgroundColor), in: Capsule())
            .overlay(Capsule().stroke(Color.winnowBorder, lineWidth: 1))
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Color.winnowCard.opacity(0.9))
    }

    // MARK: - Email list — empty states, rows, selection highlight

    private var emailList: some View {
        Group {
            if store.filteredThreads.isEmpty {
                emptyState
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(store.filteredThreads) { thread in
                                emailListRow(thread)
                            }
                        }
                        .padding(.vertical, 4)
                        // Clear the floating rail so the last row stays readable.
                        .padding(.bottom, 48)
                    }
                    .background(Color.winnowBackground)
                    .onChange(of: store.selectedRowIndex) { _, newIndex in
                        guard let newIndex,
                              store.filteredThreads.indices.contains(newIndex) else { return }
                        withAnimation(.easeOut(duration: 0.12)) {
                            proxy.scrollTo(store.filteredThreads[newIndex].representative.id, anchor: .center)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Per-mailbox empty message. Archive, Trash, and Spam are live Gmail
    /// views now — they only say "empty" when there really is nothing there.
    @ViewBuilder
    private var emptyState: some View {
        switch store.mailbox {
        case .inbox:
            VStack(alignment: .leading, spacing: 4) {
                if store.inbox.isEmpty {
                    Text("No emails. Lucky you.").font(.callout.weight(.medium)).foregroundStyle(.secondary)
                    Text("Only when there's nothing there.").font(.caption).foregroundStyle(.tertiary).padding(.leading, 8)
                } else { ContentUnavailableView.search }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        case .archive:
            ContentUnavailableView(
                "Archive is empty",
                systemImage: "archivebox",
                description: Text("Archived messages appear here.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .trash:
            ContentUnavailableView(
                "Trash is empty",
                systemImage: "trash",
                description: Text("Trashed messages appear here until permanently deleted.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .spam:
            ContentUnavailableView(
                "Spam is empty",
                systemImage: "exclamationmark.triangle",
                description: Text("Messages flagged as spam appear here — select one and press e to report it as not spam.")
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// One list row: the conversation's representative email plus its tappable
    /// star and smart-filter indicators, opened by tapping anywhere else on the
    /// row. Conversation density rides the row as a count chip.
    private func emailListRow(_ thread: EmailThreadRow) -> some View {
        let representative = thread.representative
        let sig = store.emailSignals[representative.id] ?? .neutral
        // Plain view + tap gesture (not Button) so the row's own buttons keep
        // their hit areas un-nested.
        return EmailRow(
            email: representative,
            sig: sig,
            conversationCount: thread.conversationCount,
            onToggleStar: {
                withAnimation(.easeOut(duration: 0.15)) { store.toggleStar(representative.id) }
            },
            activeFilters: store.activeFilters,
            onToggleFilter: { filter in
                withAnimation(.easeOut(duration: 0.18)) {
                    store.toggleFilter(.builtin(filter))
                }
            },
            removedFilters: store.removedFilters
        )
        .padding(.horizontal, 16)
        .contentShape(Rectangle())
        .onTapGesture { store.openEmail(representative.id) }
        .background(rowBackground(for: thread))
        .overlay(alignment: .bottom) { Divider().padding(.leading, 64) }
        .accessibilityAction(named: "Open message") { store.openEmail(representative.id) }
    }

    private func rowBackground(for thread: EmailThreadRow) -> Color {
        // Open card: the row behind it is emphasized.
        if let selectedID = store.selectedEmailID, thread.contains(selectedID) {
            return Color.accentColor.opacity(0.08)
        }
        // Keyboard cursor: a fainter wash on the row the keys are on.
        if let cursor = store.selectedRowIndex,
           store.filteredThreads.indices.contains(cursor),
           store.filteredThreads[cursor].id == thread.id {
            return Color.accentColor.opacity(0.045)
        }
        return Color.clear
    }
}

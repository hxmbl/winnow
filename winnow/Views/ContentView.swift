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
        .background { keyboardShortcuts }
        // Keybinds are scoped to *this* window: the Settings scene must never
        // route `j/k` into the inbox.
        .background { MainWindowReader { window in attachKeybinds(to: window) } }
        .onChange(of: store.searchFocusToken) { _, _ in searchFocused = true }
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

        func updateNSView(_ nsView: NSView, context: Context) {}
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
                    if store.isRefreshing { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.clockwise") }
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
        }
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
            if store.filteredEmails.isEmpty {
                emptyState
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(store.filteredEmails) { row in
                                emailListRow(row)
                            }
                        }
                        .padding(.vertical, 4)
                        // Clear the floating rail so the last row stays readable.
                        .padding(.bottom, 48)
                    }
                    .background(Color.winnowBackground)
                    .onChange(of: store.selectedRowIndex) { _, newIndex in
                        guard let newIndex,
                              store.filteredEmails.indices.contains(newIndex) else { return }
                        withAnimation(.easeOut(duration: 0.12)) {
                            proxy.scrollTo(store.filteredEmails[newIndex].email.id, anchor: .center)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Per-mailbox empty message. Archive and Trash are live Gmail views now —
    /// they only say "empty" when there really is nothing there.
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
        }
    }

    /// One inbox row: the email plus its tappable star and smart-filter
    /// indicators, opened by tapping anywhere else on the row.
    private func emailListRow(_ row: EmailRowModel) -> some View {
        // Plain view + tap gesture (not Button) so the row's own buttons keep
        // their hit areas un-nested.
        EmailRow(
            email: row.email,
            sig: row.sig,
            onToggleStar: {
                withAnimation(.easeOut(duration: 0.15)) { store.toggleStar(row.email.id) }
            },
            activeFilters: store.activeFilters,
            onToggleFilter: { filter in
                withAnimation(.easeOut(duration: 0.18)) {
                    store.toggleFilter(.builtin(filter))
                }
            }
        )
        .padding(.horizontal, 16)
        .contentShape(Rectangle())
        .onTapGesture { store.openEmail(row.email.id) }
        .background(rowBackground(for: row.email.id))
        .overlay(alignment: .bottom) { Divider().padding(.leading, 64) }
        .accessibilityAction(named: "Open message") { store.openEmail(row.email.id) }
    }

    private func rowBackground(for id: Int) -> Color {
        if store.selectedEmailID == id { return Color.accentColor.opacity(0.08) }
        // Keyboard cursor: a fainter wash on the row the keys are on.
        if let cursor = store.selectedRowIndex,
           store.filteredEmails.indices.contains(cursor),
           store.filteredEmails[cursor].email.id == id {
            return Color.accentColor.opacity(0.045)
        }
        return Color.clear
    }
}

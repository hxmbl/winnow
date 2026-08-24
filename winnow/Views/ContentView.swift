import SwiftUI

/// Root view of the main window: login gate, email canvas, toolbar, and the
/// floating bottom filter rail with the fixed Inbox mailbox menu.
struct ContentView: View {
    @Bindable var store: WinnowStore
    @State private var selectedMailbox: Mailbox = .inbox
    @FocusState private var searchFocused: Bool

    // MARK: - Body

    var body: some View {
        Group {
            if store.authed {
                NavigationStack {
                    canvasStack
                }
            } else {
                LoginScreen(onSignIn: { Task { await store.signIn() } }, errorMessage: store.lastAuthError)
            }
        }
        .preferredColorScheme(store.chosenScheme)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay { emailPresentation }
        .background { keyboardShortcuts }
    }

    /// Invisible shortcut hosts: Esc closes the reader card, Cmd-F focuses the
    /// search field. Kept out of the visible layout.
    private var keyboardShortcuts: some View {
        Group {
            Button("Close message") { dismissEmail() }
                .keyboardShortcut(.cancelAction)
            Button("Find") { searchFocused = true }
                .keyboardShortcut("f", modifiers: .command)
        }
        .opacity(0)
        .accessibilityHidden(true)
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
                    if store.loading { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.clockwise") }
                }
                .keyboardShortcut("r", modifiers: .command)
                .help("Refresh inbox")
                .disabled(store.loading)
            }
        }
    }

    private var emailCanvas: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor).ignoresSafeArea()
            VStack(spacing: 0) {
                headerBar
                Divider().opacity(0.5)
                emailList
            }
        }
    }

    private var bottomOverlay: some View {
        ZStack(alignment: .leading) {
            FilterRail(store: store)

            // Fixed Inbox menu — does NOT scroll, sits visually over the rail
            MailboxMenu(selection: $selectedMailbox)
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
            if selectedMailbox != .inbox {
                ContentUnavailableView(
                    selectedMailbox == .archive ? "Archive is empty" : "Trash is empty",
                    systemImage: selectedMailbox.icon,
                    description: Text("Move and delete actions aren't wired up in this demo yet.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.filteredEmails.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    if store.inbox.isEmpty {
                        Text("No emails. Lucky you.").font(.callout.weight(.medium)).foregroundStyle(.secondary)
                        Text("Only when there's nothing there.").font(.caption).foregroundStyle(.tertiary).padding(.leading, 8)
                    } else { ContentUnavailableView.search }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
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
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        store.selectedEmailID == id ? Color.accentColor.opacity(0.08) : Color.clear
    }
}

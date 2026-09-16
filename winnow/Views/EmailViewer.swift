import SwiftUI
import UniformTypeIdentifiers

/// Floating card content for a selected email — displays the message only.
/// Presentation (scrim, padding, dismissal) lives in ContentView.
struct EmailViewer: View {
    let email: WinnowEmail
    @Bindable var store: WinnowStore
    @State private var replyText = ""
    @State private var attachments: [URL] = []
    @State private var showFilePicker = false
    @State private var fontDesign: ReplyFontDesign = .default
    @State private var fontSize: ReplyFontSize = .medium
    @State private var notice: String?
    @State private var sending = false
    @State private var downloadError: String?
    @FocusState private var replyFocused: Bool

    /// Cached classification from the store — recomputing it here would run the
    /// rule engine again on every render of the card. A miss is a cache bug,
    /// so debug builds fail loudly instead of quietly reading "clean".
    private var sig: EmailSignals {
        guard let cached = store.emailSignals[email.id] else {
            assertionFailure("No cached signals for email \(email.id); falling back to neutral")
            return .neutral
        }
        return cached
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    senderRow
                    if !sig.badgeFilters.isEmpty {
                        badges
                    }
                    headerRow
                    if !email.attachments.isEmpty {
                        incomingAttachmentSection
                    }
                    Text(email.body)
                        .font(.body)
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(24)
            }
            replyComposer
        }
        .background(Color.winnowCard)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color.winnowBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.22), radius: 28, x: 0, y: 10)
        .fileImporter(
            isPresented: $showFilePicker,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            if case .success(let urls) = result {
                for url in urls where !attachments.contains(url) {
                    attachments.append(url)
                }
            }
        }
    }

    // MARK: - Message header

    private var senderRow: some View {
        HStack(spacing: 12) {
            AvatarView(sender: email.sender, size: 48, font: .title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(email.displayName)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .textSelection(.enabled)
                Text(email.displayAddress)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .textSelection(.enabled)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(formatListTime(email.receivedAt))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .textSelection(.enabled)
                if !store.isSenderBlocked(email.sender) {
                    Button {
                        store.blockSender(email.sender)
                        store.dismissEmail()
                    } label: {
                        Label("Block sender", systemImage: "hand.raised")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Hide future mail from \(email.sender)")
                }
            }
        }
        .padding(.bottom, 20)
    }

    /// Subject plus the read/unread toggle. Opening a message marks it read;
    /// this button lets the reader flip it back (or forward) manually.
    private var headerRow: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(email.subject)
                .font(.title2.weight(.bold))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
            Spacer()
            Button {
                withAnimation(.easeOut(duration: 0.15)) { store.toggleRead(email.id) }
            } label: {
                Label(email.unread ? "Unread" : "Mark unread", systemImage: email.unread ? "envelope.badge.fill" : "envelope.open")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("Toggle read / unread (m)")
        }
        .padding(.bottom, 12)
    }

    // MARK: - Incoming attachments

    /// Attachments that arrived with the message. Payloads are fetched from
    /// Gmail on demand and saved via the system panel (sandbox: user-chosen
    /// read-write scope).
    private var incomingAttachmentSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Attachments")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(email.attachments) { attachment in
                        incomingAttachmentChip(attachment)
                    }
                }
            }
            if let downloadError {
                Text(downloadError)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.bottom, 16)
    }

    private func incomingAttachmentChip(_ attachment: EmailAttachment) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "paperclip")
                .font(.caption2)
                .foregroundStyle(Color.winnowSecondary)
            Text(attachment.filename)
                .font(.caption)
                .lineLimit(1)
                .textSelection(.enabled)
            Button {
                saveAttachment(attachment)
            } label: {
                Image(systemName: "square.and.arrow.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.winnowSecondary)
            }
            .buttonStyle(.plain)
            .help("Save \(attachment.filename)")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.winnowCard, in: Capsule())
        .overlay(Capsule().stroke(Color.winnowBorder, lineWidth: 1))
    }

    /// Fetches the (base64url) payload over Gmail and writes it to disk. The
    /// base64 decode + write runs off the main actor so big binaries don't
    /// stall the card, and the sandbox write happens under the NSSavePanel's
    /// user-granted read-write scope.
    private func saveAttachment(_ attachment: EmailAttachment) {
        downloadError = nil
        guard let backend = store.liveBackend,
              let gmailID = backend.cache.gmailID(for: email.id) else {
            downloadError = "Attachment downloads need a live Gmail session."
            return
        }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = attachment.filename
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let client = backend.client
        Task {
            do {
                let remote = try await client.attachment(messageID: gmailID, attachmentID: attachment.id)
                guard let data = remote.data.flatMap(Base64URL.decode) else {
                    downloadError = "Attachment payload was empty."
                    return
                }
                try await Task.detached(priority: .userInitiated) { () throws in
                    try data.write(to: url, options: .atomic)
                }.value
                flashNotice("Saved \(attachment.filename).", seconds: 2)
            } catch {
                downloadError = "Couldn't save \(attachment.filename): \(error.localizedDescription)"
            }
        }
    }

    private var badges: some View {
        let palette = BuiltinSmartFilter.starred.palette
        return HStack(spacing: 8) {
            // Star is always shown: filled + tinted when starred, outlined +
            // neutral when not. Tapping toggles it (and trains the learner).
            Button { store.toggleStar(email.id) } label: {
                Image(systemName: email.starred ? "star.fill" : "star")
                    .font(.callout.weight(.bold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(email.starred ? palette.bg : Color.clear, in: Capsule())
                    .overlay(Capsule().stroke(email.starred ? palette.border : Color.winnowBorder, lineWidth: 1))
                    .foregroundStyle(email.starred ? palette.text : Color.winnowSecondary)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(email.starred ? "Remove star" : "Add star")
            .help(email.starred ? "Remove star" : "Add star")
            // Every smart-filter indicator acts like the star: tapping toggles
            // its bucket in the main list; the checkmark mirrors the pill rail.
            ForEach(sig.badgeFilters, id: \.self) { filter in
                Button {
                    withAnimation(.easeOut(duration: 0.18)) {
                        store.toggleFilter(.builtin(filter))
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: filter.iconName)
                        if store.activeFilters.contains(.builtin(filter)) {
                            Image(systemName: "checkmark")
                                .font(.caption2.weight(.bold))
                        }
                    }
                    .font(.callout.weight(.bold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(filter.palette.bg, in: Capsule())
                    .overlay(Capsule().stroke(filter.palette.border, lineWidth: 1))
                    .foregroundStyle(filter.palette.text)
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(store.activeFilters.contains(.builtin(filter)) ? "\(filter.label) filter, on" : "\(filter.label) filter")
                .help("Toggle \(filter.label) filter")
            }
        }
        .padding(.bottom, 16)
    }

    // MARK: - Reply composer

    private var replyComposer: some View {
        VStack(alignment: .leading, spacing: 10) {
            composerToolbar
            replyField
            if !attachments.isEmpty {
                attachmentChips
            }
            if let notice {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(Color.winnowSecondary)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
        .animation(.easeOut(duration: 0.2), value: notice)
    }

    private var composerToolbar: some View {
        HStack(spacing: 16) {
            toolButton("paperclip", help: "Attach files") { showFilePicker = true }
            fontMenu
            Spacer()
            sendButton
        }
    }

    private var fontMenu: some View {
        Menu {
            Picker("Typeface", selection: $fontDesign) {
                ForEach(ReplyFontDesign.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
            Picker("Size", selection: $fontSize) {
                ForEach(ReplyFontSize.allCases) { option in
                    Text(option.label).tag(option)
                }
            }
        } label: {
            Image(systemName: "textformat")
                .font(.body.weight(.medium))
                .foregroundStyle(Color.winnowSecondary)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    private var replyField: some View {
        ZStack(alignment: .topLeading) {
            if replyText.isEmpty {
                Text("Write your reply")
                    .font(replyFont)
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 6)
                    .padding(.top, 9)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $replyText)
                .font(replyFont)
                .scrollContentBackground(.hidden)
                .focused($replyFocused)
                .padding(.leading, 2)
                .padding(.top, 2)
        }
        .frame(height: 96)
        .background(Color.winnowBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(replyFocused ? Color.accentColor : Color.winnowBorder, lineWidth: 1)
        )
        .onAppear {
            if store.composerFocusToken > 0 { replyFocused = false }
        }
        .onChange(of: store.composerFocusToken) { _, _ in
            replyFocused = true
        }
    }
    private var attachmentChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments, id: \.self) { url in
                    attachmentChip(url)
                }
            }
            .padding(.horizontal, 1)
        }
    }

    private func attachmentChip(_ url: URL) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "paperclip")
                .font(.caption2)
                .foregroundStyle(Color.winnowSecondary)
            Text(url.lastPathComponent)
                .font(.caption)
                .lineLimit(1)
                .textSelection(.enabled)
            Button {
                attachments.removeAll { $0 == url }
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Color.winnowSecondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.winnowCard, in: Capsule())
        .overlay(Capsule().stroke(Color.winnowBorder, lineWidth: 1))
    }

    private var sendButton: some View {
        Button(action: sendReply) {
            HStack(spacing: 6) {
                if sending {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.up")
                    Text("Send")
                }
            }
            .font(.subheadline.weight(.semibold))
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(canSend && !sending ? Color.accentColor : Color.winnowBorder.opacity(0.5), in: Capsule())
            .foregroundStyle(canSend && !sending ? Color.white : Color.winnowSecondary)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!canSend || sending)
    }

    private func toolButton(
        _ systemImage: String,
        help: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.body.weight(.medium))
                .foregroundStyle(Color.winnowSecondary)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private var replyFont: Font {
        switch fontDesign {
        case .default: return .system(size: fontSize.pointSize)
        case .serif: return .system(size: fontSize.pointSize, design: .serif)
        case .mono: return .system(size: fontSize.pointSize, design: .monospaced)
        }
    }

    private var canSend: Bool {
        !replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    private func sendReply() {
        let body = replyText
        let files = attachments
        guard canSend, !sending else { return }
        sending = true
        Task {
            let outcome = await store.sendReply(to: email, body: body, attachmentURLs: files)
            sending = false
            switch outcome {
            case .sent:
                replyText = ""
                attachments = []
                flashNotice("Sent.", seconds: 2)
            case .demo:
                replyText = ""
                attachments = []
                flashNotice("Demo build — replies aren't actually sent.", seconds: 2.5)
            case .failed(let message):
                flashNotice("Send failed: \(message)", seconds: 5)
            }
        }
    }

    private func flashNotice(_ text: String, seconds: Double) {
        notice = text
        Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            if notice == text { notice = nil }
        }
    }
}

// MARK: - Reply composer typography options

enum ReplyFontDesign: String, CaseIterable, Identifiable {
    case `default`, serif, mono

    var id: String { rawValue }

    var label: String {
        switch self {
        case .default: return "Default"
        case .serif: return "Serif"
        case .mono: return "Monospaced"
        }
    }
}

enum ReplyFontSize: Int, CaseIterable, Identifiable {
    case small, medium, large

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .small: return "Small"
        case .medium: return "Medium"
        case .large: return "Large"
        }
    }

    var pointSize: CGFloat {
        switch self {
        case .small: return 13
        case .medium: return 15
        case .large: return 18
        }
    }
}

import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Floating card content for a selected conversation — renders every message
/// that shares the email's Gmail thread, oldest → newest, so the reader sees
/// the whole exchange instead of a single message. Presentation (scrim,
/// padding, dismissal) lives in ContentView.
struct EmailViewer: View {
    let email: WinnowEmail
    @Bindable var store: WinnowStore
    @State private var replyText = ""
    /// The exact quoted-original block currently live in `replyText`. When set
    /// and still suffixing the text, the toolbar button removes it; when the
    /// user edited inside the quote it is cleared and the text is left alone.
    @State private var quoteBlock: String?
    @State private var attachments: [URL] = []
    @State private var showFilePicker = false
    @State private var fontDesign: ReplyFontDesign = .default
    @State private var fontSize: ReplyFontSize = .medium
    @State private var notice: String?
    @State private var sending = false
    @State private var downloadError: String?
    @FocusState private var replyFocused: Bool

    /// The full conversation behind the focused message (its thread),
    /// oldest → newest. Standalone mail resolves to just itself, so the reader
    /// renders identically for both.
    private var conversation: [WinnowEmail] {
        store.conversation(for: email)
    }

    /// Signals are cached per message; archived/trashed/spam rows are never
    /// classified, so a miss is a neutral signal (empty badge row) rather than
    /// a loud cache-bug assertion.
    private func signals(for message: WinnowEmail) -> EmailSignals {
        store.emailSignals[message.id] ?? .neutral
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                // STO-134: lazy so each message's WKWebView (a fresh sandboxed
                // WebContent process) is created only as it scrolls into view —
                // building all of them eagerly made opening a conversation slow.
                LazyVStack(alignment: .leading, spacing: 0) {
                    ReaderScrollDriver(step: store.viewerScrollStep)
                    threadHeader
                    ForEach(Array(conversation.enumerated()), id: \.element.id) { index, message in
                        messageBlock(message)
                        if index < conversation.count - 1 {
                            Divider().padding(.vertical, 20)
                        }
                    }
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
        .onChange(of: email.id) { _, _ in
            resetComposer()
        }
    }

    // MARK: - Thread header

    private var threadHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            // The subject is shared across the thread — show the focused
            // message's and the conversation's size.
            Text(email.subject)
                .font(.title2.weight(.bold))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .textSelection(.enabled)
            HStack(spacing: 12) {
                Text(conversation.count == 1 ? "1 message" : "\(conversation.count) messages")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
        }
        .padding(.bottom, 20)
    }

    // MARK: - Per-message blocks

    private func messageBlock(_ message: WinnowEmail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            messageHeader(message)
            let sig = signals(for: message)
            if !sig.badgeFilters.isEmpty {
                badges(for: message, sig: sig)
            }
            messageBody(message)
            if !message.attachments.isEmpty {
                incomingAttachmentSection(message)
            }
        }
    }

    private func messageHeader(_ message: WinnowEmail) -> some View {
        HStack(alignment: .top, spacing: 12) {
            AvatarView(sender: message.sender, size: 40, font: .callout)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(message.displayName)
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .textSelection(.enabled)
                    if message.unread {
                        // The unread dot rides the message, not the whole thread —
                        // a conversation is fully read only when every member is.
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 6, height: 6)
                    }
                }
                Text(message.displayAddress)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .textSelection(.enabled)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                HStack(spacing: 8) {
                    Text(formatListTime(message.receivedAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .textSelection(.enabled)
                    Button { store.toggleStar(message.id) } label: {
                        Image(systemName: message.starred ? "star.fill" : "star")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(message.starred ? Color.yellow : Color.winnowSecondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(message.starred ? "Remove star" : "Add star")
                }
                if !store.isSenderBlocked(message.sender) {
                    Button {
                        store.blockSender(message.sender)
                        store.dismissEmail()
                    } label: {
                        Label("Block sender", systemImage: "hand.raised")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Hide future mail from \(message.sender)")
                }
            }
        }
        .padding(.bottom, 10)
    }

    // MARK: - Message body

    /// Renders one member's content: the sandboxed HTML reader when the
    /// message carried a `text/html` part, otherwise the stripped plain-text
    /// body. `.id` keyed per message so the web view (and its measured height)
    /// starts fresh instead of briefly showing the previous member's.
    private func messageBody(_ message: WinnowEmail) -> some View {
        Group {
            if let html = message.bodyHTML, !html.isEmpty {
                EmailHTMLBodyView(html: html)
            } else {
                Text(message.body)
                    .font(.body)
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .id(message.id)
    }

    // MARK: - Incoming attachments

    /// Attachments that arrived with one message. Payloads are fetched from
    /// Gmail on demand and saved via the system panel (sandbox: user-chosen
    /// read-write scope).
    private func incomingAttachmentSection(_ message: WinnowEmail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Attachments")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(message.attachments) { attachment in
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
        .padding(.top, 16)
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
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    try data.write(to: url, options: .atomic)
                }.value
                flashNotice("Saved \(attachment.filename).", seconds: 2)
            } catch {
                downloadError = "Couldn't save \(attachment.filename): \(error.localizedDescription)"
            }
        }
    }

    private func badges(for message: WinnowEmail, sig: EmailSignals) -> some View {
        let palette = BuiltinSmartFilter.starred.palette
        return HStack(spacing: 8) {
            // Star is always shown: filled + tinted when starred, outlined +
            // neutral when not. Tapping toggles it (and trains the learner).
            Button { store.toggleStar(message.id) } label: {
                Image(systemName: message.starred ? "star.fill" : "star")
                    .font(.callout.weight(.bold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(message.starred ? palette.bg : Color.clear, in: Capsule())
                    .overlay(Capsule().stroke(message.starred ? palette.border : Color.winnowBorder, lineWidth: 1))
                    .foregroundStyle(message.starred ? palette.text : Color.winnowSecondary)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(message.starred ? "Remove star" : "Add star")
            .help(message.starred ? "Remove star" : "Add star")
            // Every smart-filter indicator acts like the star: tapping toggles
            // its bucket in the main list; the checkmark mirrors the pill rail.
            // Silenced buckets (STO-138) hide their badge too.
            ForEach(sig.badgeFilters.filter { !store.removedFilters.contains($0) }, id: \.self) { filter in
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
            if quoteBlock != nil {
                Label("Quoted original inserted — edit it freely, or remove it with the quote button.", systemImage: "quote.opening")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
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
            toolButton(quoteBlock == nil ? "quote.opening" : "text.quote", help: quoteBlock == nil ? "Quote original message" : "Remove quoted context") {
                withAnimation(.easeOut(duration: 0.15)) { toggleQuote() }
            }
            fontMenu
            Spacer()
            sendButton
        }
    }

    /// Inserts or removes the quoted original as *real text* in the reply.
    /// Removal is only safe while the block still suffixes the text verbatim —
    /// if the user edited inside it, the block stays (as text) with a notice.
    private func toggleQuote() {
        if let block = quoteBlock {
            if ReplyQuoting.isSuffix(block, of: replyText) {
                replyText.removeSubrange(replyText.index(replyText.endIndex, offsetBy: -block.count)..<replyText.endIndex)
                replyText = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
                quoteBlock = nil
            } else {
                quoteBlock = nil
                flashNotice("The quoted original was edited, so it stays as text.", seconds: 3)
            }
        } else {
            let block = ReplyQuoting.block(original: email)
            let existing = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
            replyText = existing.isEmpty ? block : existing + "\n\n" + block
            quoteBlock = block
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
        // STO-125: the reply body is `replyText` verbatim — any quoted
        // original is already real, editable text inside it. The outgoing
        // thread headers (In-Reply-To / References) are attached by
        // OutgoingDraft + MIMEBuilder, unchanged.
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
                quoteBlock = nil
                attachments = []
                flashNotice("Sent.", seconds: 2)
            case .demo:
                replyText = ""
                quoteBlock = nil
                attachments = []
                flashNotice("Demo build — replies aren't actually sent.", seconds: 2.5)
            case .failed(let message):
                flashNotice("Send failed: \(message)", seconds: 5)
            }
        }
    }

    /// Composer state belongs to the currently displayed conversation. Keep an
    /// explicit reset here as a second line of defence if the parent ever
    /// reuses the viewer instead of replacing it with `.id(email.id)`.
    private func resetComposer() {
        replyText = ""
        quoteBlock = nil
        attachments = []
        notice = nil
        downloadError = nil
        sending = false
        replyFocused = false
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

// MARK: - STO-137 arrow-key scroll driver

/// Bridges the reader's arrow-key requests (`.scrollReader`) into its own
/// `NSScrollView`. The keybind engine routes ↑/↓ to the store's cumulative
/// `viewerScrollStep` while a message is open; this zero-size view sits inside
/// the reader's `ScrollView`, where it finds the *enclosing* scroller and
/// nudges the clip view by a visible-height fraction per accumulated step.
///
/// Resolving the scroll view by walking up from inside the content guarantees
/// we always target the reader card's scroller — never the email list behind
/// it or another window (Settings). Both scroll orientations are handled by
/// measuring from `documentVisibleRect` and flipping the direction per the
/// document's own `isFlipped`.
private struct ReaderScrollDriver: NSViewRepresentable {
    let step: Int

    final class Coordinator {
        var lastStep = 0
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        NSView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        let coordinator = context.coordinator
        defer { coordinator.lastStep = step }
        guard step != coordinator.lastStep,
              let scrollView = Self.enclosingScrollView(of: nsView) else { return }
        Self.scroll(scrollView, by: step - coordinator.lastStep)
    }

    private static func enclosingScrollView(of view: NSView) -> NSScrollView? {
        var candidate = view.superview
        while let current = candidate {
            if let scrollView = current as? NSScrollView { return scrollView }
            candidate = current.superview
        }
        return nil
    }

    /// Scrolls the clip view by `steps` × a visible-height fraction (capped at
    /// one page and a comfortable minimum), clamped to the document bounds, so
    /// a long HTML message moves a useful amount per press.
    private static func scroll(_ scrollView: NSScrollView, by steps: Int) {
        let clip = scrollView.contentView
        let visibleHeight = max(1, clip.bounds.height)
        let stepHeight = max(60, visibleHeight * 0.35)
        let documentHeight = max(visibleHeight, scrollView.documentView?.frame.height ?? visibleHeight)
        let flipped = scrollView.documentView?.isFlipped ?? false
        let direction = CGFloat(steps) * stepHeight * (flipped ? 1 : -1)
        let currentY = scrollView.documentVisibleRect.minY
        let targetY = min(max(0, documentHeight - visibleHeight), max(0, currentY + direction))
        guard targetY != currentY else { return }
        clip.scroll(to: NSPoint(x: 0, y: targetY))
        scrollView.reflectScrolledClipView(clip)
    }
}

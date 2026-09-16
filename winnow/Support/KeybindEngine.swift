import AppKit

/// A single key command the engine can emit.
enum KeyCommand: Equatable {
    case moveSelection(Int)
    case openSelected
    case closeViewer
    case dismissOverlay
    case toggleStar
    case archive
    case trash
    case restore
    case toggleRead
    case focusReply
    case focusSearch
    case toggleShortcutsOverlay
    case toggleFilter(railIndex: Int)
    case blurText
}

/// Home-row keyboard control, Mutt/Superhuman style.
///
/// DESIGN
/// - `command(forCharacter:keyCode:context:)` is a **pure function** — all
///   routing decisions are unit-testable without AppKit events. The monitor
///   below is a thin shell that builds the context and applies the command.
/// - **Typing safety**: while any text field or editor is first responder,
///   every key passes straight through except Esc (which blurs the field).
///   Typing "s" in a reply must never star an email.
/// - Only unmodified keys are captured; ⌘/⌃/⌥ combos belong to system and
///   menu shortcuts and are never intercepted.
@MainActor
final class KeybindEngine {
    struct Context: Equatable {
        var authed: Bool
        var textEditing: Bool
        var viewerOpen: Bool
        var overlayVisible: Bool
        var hasActionTarget: Bool
        var railCount: Int
    }

    /// Cheat-sheet entry: what the cheat sheet shows, in order.
    struct Binding {
        let display: String
        let help: String
        let command: KeyCommand
    }

    static let bindings: [Binding] = [
        Binding(display: "j", help: "Next message", command: .moveSelection(1)),
        Binding(display: "k", help: "Previous message", command: .moveSelection(-1)),
        Binding(display: "o / ⏎", help: "Open highlighted message", command: .openSelected),
        Binding(display: "Esc", help: "Close message · dismiss overlay · blur field", command: .closeViewer),
        Binding(display: "s", help: "Star / unstar", command: .toggleStar),
        Binding(display: "e", help: "Archive ⇄ unarchive ⇄ restore", command: .archive),
        Binding(display: "# / ⌫", help: "Trash · delete in Trash", command: .trash),
        Binding(display: "m", help: "Mark read / unread", command: .toggleRead),
        Binding(display: "r", help: "Reply (focus composer)", command: .focusReply),
        Binding(display: "/", help: "Search", command: .focusSearch),
        Binding(display: "1–9", help: "Toggle filter pill", command: .toggleFilter(railIndex: 0)),
        Binding(display: "?", help: "Toggle this cheat sheet", command: .toggleShortcutsOverlay),
    ]

    // MARK: - Pure routing

    /// Routes one key. `modifiers` carries the event's modifier flags so the
    /// ⌘/⌃/⌥ guard lives here — in the testable router, not the monitor shell.
    nonisolated static func command(
        forCharacter character: String?,
        keyCode: UInt16,
        context: Context,
        modifiers: UInt = 0
    ) -> KeyCommand? {
        // ⌘/⌃/⌥ combos (with or without shift) belong to system and menu
        // shortcuts and are never intercepted.
        let flags = NSEvent.ModifierFlags(rawValue: modifiers)
        guard flags.subtracting(.shift).intersection(.deviceIndependentFlagsMask).isEmpty else { return nil }
        guard context.authed else { return nil }

        let esc = keyCode == 53
        if context.textEditing {
            return esc ? .blurText : nil
        }

        if esc {
            if context.overlayVisible { return .dismissOverlay }
            if context.viewerOpen { return .closeViewer }
            return nil
        }

        // Cheat sheet open: keys must never mutate the list hidden behind it.
        // Only dismissing routes (Esc above; `?` toggles the sheet closed).
        if context.overlayVisible {
            return character == "?" ? .toggleShortcutsOverlay : nil
        }

        switch keyCode {
        case 125: return .moveSelection(1)          // ↓
        case 126: return .moveSelection(-1)         // ↑
        case 36:  return context.viewerOpen ? nil : .openSelected   // ⏎
        case 51:  return context.hasActionTarget ? .trash : nil     // ⌫
        default:  break
        }

        guard let character, !character.isEmpty else { return nil }
        switch character {
        case "j": return .moveSelection(1)
        case "k": return .moveSelection(-1)
        case "o": return context.viewerOpen ? nil : .openSelected
        case "s": return context.hasActionTarget ? .toggleStar : nil
        case "e": return context.hasActionTarget ? .archive : nil
        case "#": return context.hasActionTarget ? .trash : nil
        case "m": return context.hasActionTarget ? .toggleRead : nil
        case "r": return context.viewerOpen ? .focusReply : nil
        case "/": return .focusSearch
        case "?": return .toggleShortcutsOverlay
        case "1", "2", "3", "4", "5", "6", "7", "8", "9":
            let index = (character.first!.asciiValue! - UInt8(ascii: "1"))
            return index < UInt8(context.railCount) ? .toggleFilter(railIndex: Int(index)) : nil
        default:
            return nil
        }
    }

    // MARK: - Event monitor

    private weak var store: WinnowStore?
    /// The window whose keys these are. Events from any other window (e.g.
    /// Settings) pass through untouched — `j` in a Settings field must never
    /// move an invisible inbox cursor.
    private weak var contentWindow: NSWindow?
    private var monitor: Any?

    init(store: WinnowStore) {
        self.store = store
    }

    /// Installs the local keyDown monitor, scoped to `window`. Idempotent.
    func start(inWindow window: NSWindow?) {
        contentWindow = window
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handle(event) ?? event
        }
    }

    /// Re-points the scope after the view hierarchy moved to a new window.
    func retarget(to window: NSWindow?) {
        contentWindow = window
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    /// Returns nil when the event was consumed, else the event unchanged.
    private func handle(_ event: NSEvent) -> NSEvent? {
        guard let contentWindow, event.window === contentWindow else { return event }
        guard let store else { return event }
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask).rawValue

        let context = Context(
            authed: store.authed,
            textEditing: isTextContextActive,
            viewerOpen: store.selectedEmail != nil,
            overlayVisible: store.showShortcutOverlay,
            hasActionTarget: store.selectedEmail != nil || store.selectedRowIndex != nil,
            railCount: store.railItems.count
        )

        let character = event.charactersIgnoringModifiers
        // '#' and '?' arrive via shift; charactersIgnoringModifiers would hand
        // us '3' and '/', so prefer the produced character for printable keys.
        let produced = event.characters

        let command: KeyCommand?
        if let produced, ["#", "?"].contains(produced) {
            command = Self.command(forCharacter: produced, keyCode: event.keyCode, context: context, modifiers: modifiers)
        } else {
            command = Self.command(forCharacter: character, keyCode: event.keyCode, context: context, modifiers: modifiers)
        }

        guard let command else { return event }
        store.apply(command)
        return nil
    }

    /// Text-editing is judged by *our* window's first responder — not
    /// `NSApp.keyWindow`, which may belong to Settings or another scene.
    var isTextContextActive: Bool {
        guard let responder = contentWindow?.firstResponder else { return false }
        return responder is NSTextView
    }
}

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
        Binding(display: "e", help: "Archive", command: .archive),
        Binding(display: "# / ⌫", help: "Trash", command: .trash),
        Binding(display: "r", help: "Reply (focus composer)", command: .focusReply),
        Binding(display: "/", help: "Search", command: .focusSearch),
        Binding(display: "1–9", help: "Toggle filter pill", command: .toggleFilter(railIndex: 0)),
        Binding(display: "?", help: "Toggle this cheat sheet", command: .toggleShortcutsOverlay),
    ]

    // MARK: - Pure routing

    nonisolated static func command(
        forCharacter character: String?,
        keyCode: UInt16,
        context: Context
    ) -> KeyCommand? {
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
    private var monitor: Any?

    init(store: WinnowStore) {
        self.store = store
    }

    /// Installs the local keyDown monitor. Idempotent.
    func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handle(event) ?? event
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    /// Returns nil when the event was consumed, else the event unchanged.
    private func handle(_ event: NSEvent) -> NSEvent? {
        guard let store else { return event }
        // Modifier combos (⌘/⌃/⌥, with or without shift) are never ours.
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard modifiers.subtracting(.shift).isEmpty else { return event }

        let context = Context(
            authed: store.authed,
            textEditing: Self.isTextContextActive,
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
            command = Self.command(forCharacter: produced, keyCode: event.keyCode, context: context)
        } else {
            command = Self.command(forCharacter: character, keyCode: event.keyCode, context: context)
        }

        guard let command else { return event }
        store.apply(command)
        return nil
    }

    static var isTextContextActive: Bool {
        guard let responder = NSApp.keyWindow?.firstResponder else { return false }
        return responder is NSTextView
    }
}

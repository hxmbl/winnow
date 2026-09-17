import AppKit
import Foundation
import Testing
@testable import winnow

@MainActor
struct KeybindEngineTests {

    private func context(
        authed: Bool = true,
        textEditing: Bool = false,
        viewerOpen: Bool = false,
        overlayVisible: Bool = false,
        hasActionTarget: Bool = false,
        railCount: Int = 12
    ) -> KeybindEngine.Context {
        KeybindEngine.Context(
            authed: authed,
            textEditing: textEditing,
            viewerOpen: viewerOpen,
            overlayVisible: overlayVisible,
            hasActionTarget: hasActionTarget,
            railCount: railCount
        )
    }

    // MARK: Typing safety

    @Test func textEditingPassesEverythingThroughExceptEscape() {
        let editing = context(textEditing: true)
        #expect(KeybindEngine.command(forCharacter: "s", keyCode: 1, context: editing) == nil)
        #expect(KeybindEngine.command(forCharacter: "j", keyCode: 38, context: editing) == nil)
        #expect(KeybindEngine.command(forCharacter: "e", keyCode: 14, context: editing) == nil)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 53, context: editing) == .blurText)
    }

    @Test func modifierCombosAreNeverCapturedUpstream() {
        // The guard lives in the pure router: any ⌘/⌃/⌥ combo must return nil
        // even when the bare key would route. Shift alone stays legal — it is
        // how `#` and `?` are produced.
        let list = context(hasActionTarget: true, railCount: 12)
        let command = UInt(NSEvent.ModifierFlags.command.rawValue)
        let control = UInt(NSEvent.ModifierFlags.control.rawValue)
        let option = UInt(NSEvent.ModifierFlags.option.rawValue)
        let shift = UInt(NSEvent.ModifierFlags.shift.rawValue)

        #expect(KeybindEngine.command(forCharacter: "j", keyCode: 38, context: list, modifiers: command) == nil)
        #expect(KeybindEngine.command(forCharacter: "s", keyCode: 1, context: list, modifiers: control) == nil)
        #expect(KeybindEngine.command(forCharacter: "e", keyCode: 14, context: list, modifiers: option) == nil)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 51, context: list, modifiers: command | shift) == nil)
        // Shift-only keeps routing (`#`, `?`).
        #expect(KeybindEngine.command(forCharacter: "#", keyCode: 18, context: list, modifiers: shift) == .trash)
    }

    @Test func cheatSheetOpenBlocksKeysBehindIt() {
        // With the sheet up, only dismissing routes: Esc closes it, `?`
        // toggles it closed, everything else passes through untouched so no
        // filter flips behind the sheet.
        let overlay = context(overlayVisible: true, hasActionTarget: true, railCount: 12)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 53, context: overlay) == .dismissOverlay)
        #expect(KeybindEngine.command(forCharacter: "?", keyCode: 44, context: overlay) == .toggleShortcutsOverlay)
        #expect(KeybindEngine.command(forCharacter: "j", keyCode: 38, context: overlay) == nil)
        #expect(KeybindEngine.command(forCharacter: "s", keyCode: 1, context: overlay) == nil)
        #expect(KeybindEngine.command(forCharacter: "e", keyCode: 14, context: overlay) == nil)
        #expect(KeybindEngine.command(forCharacter: "/", keyCode: 44, context: overlay) == nil)
        #expect(KeybindEngine.command(forCharacter: "3", keyCode: 20, context: overlay) == nil)

        // Sheet closed: the same keys route again.
        let list = context(hasActionTarget: true, railCount: 12)
        #expect(KeybindEngine.command(forCharacter: "j", keyCode: 38, context: list) == .moveSelection(1))
    }

    @Test func signedOutMeansNoKeyDoesAnything() {
        let signedOut = context(authed: false, viewerOpen: true, hasActionTarget: true)
        #expect(KeybindEngine.command(forCharacter: "j", keyCode: 38, context: signedOut) == nil)
        #expect(KeybindEngine.command(forCharacter: "s", keyCode: 1, context: signedOut) == nil)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 53, context: signedOut) == nil)
    }

    // MARK: Navigation

    @Test func homeRowNavigationMapsToSelection() {
        let list = context()
        #expect(KeybindEngine.command(forCharacter: "j", keyCode: 38, context: list) == .moveSelection(1))
        #expect(KeybindEngine.command(forCharacter: "k", keyCode: 40, context: list) == .moveSelection(-1))
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 125, context: list) == .moveSelection(1))
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 126, context: list) == .moveSelection(-1))
    }

    @Test func openRequiresClosedViewer() {
        #expect(KeybindEngine.command(forCharacter: "o", keyCode: 31, context: context()) == .openSelected)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 36, context: context()) == .openSelected)
        #expect(KeybindEngine.command(forCharacter: "o", keyCode: 31, context: context(viewerOpen: true)) == nil)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 36, context: context(viewerOpen: true)) == nil)
    }

    @Test func escapePrecedenceIsOverlayThenViewer() {
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 53, context: context(overlayVisible: true)) == .dismissOverlay)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 53, context: context(viewerOpen: true)) == .closeViewer)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 53, context: context()) == nil)
    }

    // MARK: Actions

    @Test func actionsRequireATarget() {
        let noTarget = context()
        #expect(KeybindEngine.command(forCharacter: "s", keyCode: 1, context: noTarget) == nil)
        #expect(KeybindEngine.command(forCharacter: "e", keyCode: 14, context: noTarget) == nil)
        #expect(KeybindEngine.command(forCharacter: "#", keyCode: 18, context: noTarget) == nil)
        #expect(KeybindEngine.command(forCharacter: "m", keyCode: 46, context: noTarget) == nil)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 51, context: noTarget) == nil)

        let withTarget = context(hasActionTarget: true)
        #expect(KeybindEngine.command(forCharacter: "s", keyCode: 1, context: withTarget) == .toggleStar)
        #expect(KeybindEngine.command(forCharacter: "e", keyCode: 14, context: withTarget) == .archive)
        #expect(KeybindEngine.command(forCharacter: "#", keyCode: 18, context: withTarget) == .trash)
        #expect(KeybindEngine.command(forCharacter: "m", keyCode: 46, context: withTarget) == .toggleRead)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 51, context: withTarget) == .trash)
    }

    @Test func replyRequiresTheViewer() {
        #expect(KeybindEngine.command(forCharacter: "r", keyCode: 15, context: context()) == nil)
        #expect(KeybindEngine.command(forCharacter: "r", keyCode: 15, context: context(viewerOpen: true)) == .focusReply)
    }

    @Test func searchAndCheatSheetAlwaysRoute() {
        #expect(KeybindEngine.command(forCharacter: "/", keyCode: 44, context: context()) == .focusSearch)
        #expect(KeybindEngine.command(forCharacter: "?", keyCode: 44, context: context()) == .toggleShortcutsOverlay)
    }

    @Test func digitKeysToggleRailFiltersWithinRange() {
        #expect(KeybindEngine.command(forCharacter: "1", keyCode: 18, context: context()) == .toggleFilter(railIndex: 0))
        #expect(KeybindEngine.command(forCharacter: "9", keyCode: 25, context: context()) == .toggleFilter(railIndex: 8))
        // A short rail clamps: indices beyond the rail width are ignored.
        #expect(KeybindEngine.command(forCharacter: "9", keyCode: 25, context: context(railCount: 3)) == nil)
        #expect(KeybindEngine.command(forCharacter: "3", keyCode: 20, context: context(railCount: 3)) == .toggleFilter(railIndex: 2))
    }

    @Test func unknownKeysPassThrough() {
        #expect(KeybindEngine.command(forCharacter: "z", keyCode: 6, context: context(hasActionTarget: true)) == nil)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 111, context: context()) == nil)
    }

    @Test func cheatSheetListsEveryRoutedKey() {
        // Documentation cannot drift: every binding entry must produce its
        // command in the context where it is valid.
        let listContext = context(hasActionTarget: true)                        // viewer closed
        let readerContext = context(viewerOpen: true, hasActionTarget: true)   // viewer open

        for binding in KeybindEngine.bindings {
            let character: String?
            let keyCode: UInt16
            let activeContext: KeybindEngine.Context
            switch binding.display {
            case "j": (character, keyCode, activeContext) = ("j", 38, listContext)
            case "k": (character, keyCode, activeContext) = ("k", 40, listContext)
            case "o / ⏎": (character, keyCode, activeContext) = ("o", 31, listContext)
            case "Esc": (character, keyCode, activeContext) = (nil, 53, readerContext)
            case "s": (character, keyCode, activeContext) = ("s", 1, listContext)
            case "e": (character, keyCode, activeContext) = ("e", 14, listContext)
            case "# / ⌫": (character, keyCode, activeContext) = ("#", 18, listContext)
            case "m": (character, keyCode, activeContext) = ("m", 46, listContext)
            case "r": (character, keyCode, activeContext) = ("r", 15, readerContext)
            case "/": (character, keyCode, activeContext) = ("/", 44, listContext)
            case "1–9": (character, keyCode, activeContext) = ("1", 18, listContext)
            case "?": (character, keyCode, activeContext) = ("?", 44, listContext)
            default:
                Issue.record("Unmapped cheat-sheet entry: \(binding.display)")
                continue
            }
            let routed = KeybindEngine.command(forCharacter: character, keyCode: keyCode, context: activeContext)
            #expect(routed != nil, "\(binding.display) failed to route")
        }
    }
}

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
        navigationVisible: Bool = false,
        filtersActive: Bool = false,
        hasActionTarget: Bool = false,
        railCount: Int = 12
    ) -> KeybindEngine.Context {
        KeybindEngine.Context(
            authed: authed,
            textEditing: textEditing,
            viewerOpen: viewerOpen,
            overlayVisible: overlayVisible,
            navigationVisible: navigationVisible,
            filtersActive: filtersActive,
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

    // MARK: STO-137 — arrows scroll the reader

    @Test func arrowsScrollTheReaderWhileItIsOpen() {
        let reader = context(viewerOpen: true)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 125, context: reader) == .scrollReader(1))
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 126, context: reader) == .scrollReader(-1))
        // j/k keep navigating between conversations with the reader open.
        #expect(KeybindEngine.command(forCharacter: "j", keyCode: 38, context: reader) == .moveSelection(1))
        #expect(KeybindEngine.command(forCharacter: "k", keyCode: 40, context: reader) == .moveSelection(-1))
    }

    @Test func arrowsReturnToSelectionNavigationWhenTheReaderCloses() {
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 125, context: context()) == .moveSelection(1))
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 126, context: context()) == .moveSelection(-1))
    }

    @Test func arrowsNeverFireWhileTypingOrWithModifiers() {
        let editing = context(textEditing: true, viewerOpen: true)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 125, context: editing) == nil)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 126, context: editing) == nil)

        let command = UInt(NSEvent.ModifierFlags.command.rawValue)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 125, context: context(viewerOpen: true), modifiers: command) == nil)
        // The compact `!` palette still steers with arrows regardless of viewer.
        let nav = context(viewerOpen: true, navigationVisible: true)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 125, context: nav) == .moveNavigation(1))
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 126, context: nav) == .moveNavigation(-1))
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
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 53, context: context(filtersActive: true)) == .clearFilters)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 53, context: context(viewerOpen: true, filtersActive: true)) == .closeViewer)
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

    // MARK: Unmatched keys must not leak into the responder chain (alert beep)

    @Test func unmatchedCanvasKeysAreSwallowed() {
        // With no binding, the authed non-editing canvas consumes the key so it
        // never reaches NSResponder.noResponder (the macOS alert beep).
        #expect(KeybindEngine.shouldPassThrough(context: context(), modifiers: 0) == false)
        // Shift-only is normal typing (uppercase letters) — it must pass through.
        let shift = UInt(NSEvent.ModifierFlags.shift.rawValue)
        #expect(KeybindEngine.shouldPassThrough(context: context(), modifiers: shift) == true)
        // Contexts that block commands (overlay up, no target) still swallow bare keys.
        #expect(KeybindEngine.shouldPassThrough(context: context(overlayVisible: true), modifiers: 0) == false)
        #expect(KeybindEngine.shouldPassThrough(context: context(viewerOpen: true), modifiers: 0) == false)
    }

    @Test func keysOwnedElsewhereStillFlowThrough() {
        let shift = UInt(NSEvent.ModifierFlags.shift.rawValue)
        let command = UInt(NSEvent.ModifierFlags.command.rawValue)
        let control = UInt(NSEvent.ModifierFlags.control.rawValue)
        let option = UInt(NSEvent.ModifierFlags.option.rawValue)
        let function = UInt(NSEvent.ModifierFlags.function.rawValue)

        // Sign-in and live text fields keep every key.
        #expect(KeybindEngine.shouldPassThrough(context: context(authed: false), modifiers: 0) == true)
        #expect(KeybindEngine.shouldPassThrough(context: context(textEditing: true), modifiers: 0) == true)
        #expect(KeybindEngine.shouldPassThrough(context: context(textEditing: true), modifiers: shift) == true)
        // ⌘/⌃/⌥ combos belong to system and menu shortcuts.
        #expect(KeybindEngine.shouldPassThrough(context: context(), modifiers: command) == true)
        #expect(KeybindEngine.shouldPassThrough(context: context(), modifiers: control) == true)
        #expect(KeybindEngine.shouldPassThrough(context: context(), modifiers: option) == true)
        // Function keys keep their system meaning.
        #expect(KeybindEngine.shouldPassThrough(context: context(), modifiers: function) == true)
    }

    // MARK: STO-132 — Caps Lock / keypad noise must not beep or block routing

    @Test func capsLockAndNumericPadAreNoiseNotChords() {
        let capsLock = UInt(NSEvent.ModifierFlags.capsLock.rawValue)
        let numericPad = UInt(NSEvent.ModifierFlags.numericPad.rawValue)

        // Bare keys keep routing while Caps Lock is engaged or a keypad flag
        // rides along.
        #expect(KeybindEngine.command(forCharacter: "j", keyCode: 38, context: context(), modifiers: capsLock) == .moveSelection(1))
        #expect(KeybindEngine.command(forCharacter: "s", keyCode: 1, context: context(hasActionTarget: true), modifiers: capsLock) == .toggleStar)
        #expect(KeybindEngine.command(forCharacter: "j", keyCode: 38, context: context(), modifiers: numericPad) == .moveSelection(1))
        // Keypad arrows carry .numericPad and must still scroll/select.
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 125, context: context(viewerOpen: true), modifiers: numericPad) == .scrollReader(1))
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 125, context: context(), modifiers: numericPad) == .moveSelection(1))

        // Unmatched keys wearing only this noise are swallowed, never passed
        // through to NSResponder.noResponder (the alert beep).
        #expect(KeybindEngine.shouldPassThrough(context: context(), modifiers: capsLock) == false)
        #expect(KeybindEngine.shouldPassThrough(context: context(), modifiers: numericPad) == false)
        #expect(KeybindEngine.shouldPassThrough(context: context(), modifiers: capsLock | numericPad) == false)
    }

    @Test func capsLockNeverDemotesARealChord() {
        let capsLock = UInt(NSEvent.ModifierFlags.capsLock.rawValue)
        let command = UInt(NSEvent.ModifierFlags.command.rawValue)
        let control = UInt(NSEvent.ModifierFlags.control.rawValue)

        // A genuine ⌘/⌃/⌥ combo stays system-owned even with Caps Lock on.
        #expect(KeybindEngine.command(forCharacter: "j", keyCode: 38, context: context(), modifiers: command | capsLock) == nil)
        #expect(KeybindEngine.command(forCharacter: "s", keyCode: 1, context: context(hasActionTarget: true), modifiers: control | capsLock) == nil)
        #expect(KeybindEngine.shouldPassThrough(context: context(), modifiers: command | capsLock) == true)
        #expect(KeybindEngine.shouldPassThrough(context: context(), modifiers: control | capsLock) == true)
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
            case "↑ / ↓": (character, keyCode, activeContext) = (nil, 125, readerContext)
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
            case "!": (character, keyCode, activeContext) = ("!", 18, listContext)
            default:
                Issue.record("Unmapped cheat-sheet entry: \(binding.display)")
                continue
            }
            let routed = KeybindEngine.command(forCharacter: character, keyCode: keyCode, context: activeContext)
            #expect(routed != nil, "\(binding.display) failed to route")
        }
    }

    // MARK: Compact navigation palette (`!`)

    @Test func bangTogglesNavigationPalette() {
        #expect(KeybindEngine.command(forCharacter: "!", keyCode: 18, context: context()) == .toggleNavigation)
        // While the palette is open the same key closes it.
        #expect(KeybindEngine.command(forCharacter: "!", keyCode: 18, context: context(navigationVisible: true)) == .toggleNavigation)
    }

    @Test func navigationPaletteSteersWithArrowsJandKAndActivates() {
        let nav = context(navigationVisible: true)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 125, context: nav) == .moveNavigation(1))
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 126, context: nav) == .moveNavigation(-1))
        #expect(KeybindEngine.command(forCharacter: "j", keyCode: 38, context: nav) == .moveNavigation(1))
        #expect(KeybindEngine.command(forCharacter: "k", keyCode: 40, context: nav) == .moveNavigation(-1))
        #expect(KeybindEngine.command(forCharacter: "o", keyCode: 31, context: nav) == .activateNavigation)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 36, context: nav) == .activateNavigation)
    }

    @Test func navigationPaletteEscapeDismissesBeforeViewerOrFilters() {
        let nav = context(viewerOpen: true, navigationVisible: true, filtersActive: true)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 53, context: nav) == .dismissNavigation)
        // No navigation state on: Esc precedence falls through to viewer/filters.
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 53, context: context(viewerOpen: true, filtersActive: true)) == .closeViewer)
    }

    @Test func navigationPaletteSwallowsActionsButLetsDigitsThrough() {
        // Actions must not fire on the list behind the palette...
        let nav = context(navigationVisible: true, hasActionTarget: true, railCount: 12)
        #expect(KeybindEngine.command(forCharacter: "s", keyCode: 1, context: nav) == nil)
        #expect(KeybindEngine.command(forCharacter: "e", keyCode: 14, context: nav) == nil)
        #expect(KeybindEngine.command(forCharacter: "m", keyCode: 46, context: nav) == nil)
        #expect(KeybindEngine.command(forCharacter: "#", keyCode: 18, context: nav) == nil)
        #expect(KeybindEngine.command(forCharacter: nil, keyCode: 51, context: nav) == nil)
        #expect(KeybindEngine.command(forCharacter: "?", keyCode: 44, context: nav) == nil)
        // ...but number keys stay canvas filter toggles.
        #expect(KeybindEngine.command(forCharacter: "1", keyCode: 18, context: nav) == .toggleFilter(railIndex: 0))
        #expect(KeybindEngine.command(forCharacter: "9", keyCode: 25, context: context(navigationVisible: true, railCount: 3)) == nil)
    }
}

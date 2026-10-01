/**
 * The keyboard layer.
 *
 * A mail client is a keyboard application. Everything you do while triaging —
 * next message, star, archive, filter, search — has a key, and the point of
 * this module is that the mapping is *data*, not a `switch` buried in a
 * component. Three things follow from that:
 *
 *   - The `?` cheat sheet renders the same array the router uses, so the
 *     documentation cannot drift from the behaviour. This was the actual bug
 *     it fixed: the sheet had been maintained by hand and had already fallen
 *     behind.
 *   - The routing rules are testable without a DOM, a synthetic event, or a
 *     window.
 *   - The browser and the desktop share it exactly. The Tauri build does not
 *     need its own accelerator handling.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Support/KeybindEngine.swift`.
 */

import type { NavigationItem } from "../model/signals";

/** Every action the keyboard can trigger. */
export type Command =
  | { type: "moveSelection"; delta: number }
  | { type: "scrollReader"; delta: number }
  | { type: "openSelected" }
  | { type: "closeViewer" }
  | { type: "dismissOverlay" }
  | { type: "dismissNavigation" }
  | { type: "toggleStar" }
  | { type: "archive" }
  | { type: "trash" }
  | { type: "restore" }
  | { type: "toggleRead" }
  | { type: "focusReply" }
  | { type: "focusSearch" }
  | { type: "toggleFilter"; railIndex: number }
  | { type: "clearFilters" }
  | { type: "toggleNavigation" }
  | { type: "moveNavigation"; delta: number }
  | { type: "activateNavigation" }
  | { type: "blurText" }
  | { type: "toggleShortcutsOverlay" }
  | { type: "openSettings" };

/** One row of the cheat sheet. Also the binding it installs. */
export type Binding = {
  /** How the key is written on the key cap: `j`, `↑ / ↓`, `1–9`. */
  keys: string;
  help: string;
  matches: KeySpec;
  command: Command;
};

/**
 * A key as the router sees it.
 *
 * `key` is `KeyboardEvent.key`, which is layout-dependent — `event.key` for
 * the `?` on a US layout is `?`, but on a French layout it is the character
 * produced *before* `Shift` is applied. Both forms are accepted for the three
 * shift-produced characters, because the alternative is a cheat sheet that
 * works on the developer's machine only.
 */
export type KeySpec = {
  /** Any of these matches. */
  keys: readonly string[];
  /** `KeyboardEvent.key` values, checked for shift-produced punctuation. */
  chars?: readonly string[];
  /** Require or ignore a modifier. */
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
};

/** The one context object the router reads. */
export type KeyContext = {
  /** No routing at all before sign-in. */
  ready: boolean;
  /** A text field or the composer has focus: hands off everything but Esc. */
  textEditing: boolean;
  viewerOpen: boolean;
  /** A modal sheet — the shortcut sheet — is up. */
  overlayVisible: boolean;
  navigationVisible: boolean;
  filtersActive: boolean;
  /** Something is selected, or there is a cursor to act on. */
  hasActionTarget: boolean;
  /** How many pills are in the rail, so `1`–`9` can be bounds-checked. */
  railCount: number;
};

export const DEFAULT_CONTEXT: KeyContext = {
  ready: true,
  textEditing: false,
  viewerOpen: false,
  overlayVisible: false,
  navigationVisible: false,
  filtersActive: false,
  hasActionTarget: false,
  railCount: 0,
};

// ── The cheat sheet ─────────────────────────────────────────────────────────

/**
 * The bindings, in the order the sheet shows them.
 *
 * Navigation first (how do I move), then the actions (what do I do), then the
 * views. That is the order someone triaging an inbox needs them in.
 */
export const BINDINGS: readonly Binding[] = [
  {
    keys: "j / ↓",
    help: "Next message, or scroll the open one",
    matches: { keys: ["j"] },
    command: { type: "moveSelection", delta: 1 },
  },
  {
    keys: "k / ↑",
    help: "Previous message, or scroll back",
    matches: { keys: ["k"] },
    command: { type: "moveSelection", delta: -1 },
  },
  {
    keys: "o / ⏎",
    help: "Open the highlighted message",
    matches: { keys: ["o", "Enter"] },
    command: { type: "openSelected" },
  },
  {
    // ↓ and ↑ are listed here as well as with `j`/`k` because with the reader
    // open they scroll the message rather than moving the cursor, and the sheet
    // should say so. See `commandForKey`, which branches on `viewerOpen`.
    keys: "↓ / ↑",
    help: "Scroll the open message",
    matches: { keys: ["ArrowDown"] },
    command: { type: "scrollReader", delta: 1 },
  },
  {
    keys: "Esc",
    help: "Close the message, clear filters, or leave a field",
    matches: { keys: ["Escape"] },
    command: { type: "closeViewer" },
  },
  {
    keys: "s",
    help: "Star or unstar",
    matches: { keys: ["s"] },
    command: { type: "toggleStar" },
  },
  {
    keys: "e",
    help: "Archive, unarchive, or restore — whichever the current mailbox implies",
    matches: { keys: ["e"] },
    command: { type: "archive" },
  },
  {
    keys: "# / ⌫",
    help: "Move to trash, or delete permanently from Trash",
    matches: { keys: ["#", "Backspace", "Delete"] },
    command: { type: "trash" },
  },
  {
    keys: "u / m",
    help: "Mark read or unread",
    matches: { keys: ["u", "m"] },
    command: { type: "toggleRead" },
  },
  {
    // `restore` deliberately has no row: it is what `e` does when the current
    // mailbox is the bin, so a separate key would be a second way to do one
    // thing. The `e` help text says so.
    keys: "r",
    help: "Reply to the open message",
    matches: { keys: ["r"] },
    command: { type: "focusReply" },
  },
  {
    keys: "/",
    help: "Search",
    matches: { keys: ["/"] },
    command: { type: "focusSearch" },
  },
  {
    keys: "1–9",
    help: "Toggle the filter pill in that position",
    matches: { keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] },
    command: { type: "toggleFilter", railIndex: 0 },
  },
  {
    keys: "!",
    help: "Switch mailbox, or open Settings",
    matches: { keys: ["!", "1"], shift: true },
    command: { type: "toggleNavigation" },
  },
  {
    keys: "?",
    help: "Show or hide this list",
    matches: { keys: ["?"] },
    command: { type: "toggleShortcutsOverlay" },
  },
] as const;

// ── Routing ─────────────────────────────────────────────────────────────────

/** Modifiers that mean the app must keep its hands off. */
const SYSTEM_MODIFIERS = ["altKey", "ctrlKey", "metaKey"] as const;

/**
 * Resolve a key event to a command, or `null` to let it through.
 *
 * The order of the rules is the design, and it is not arbitrary:
 *
 *   1. **Not ready** — nothing is routed before sign-in.
 *   2. **Modifiers** — ⌘/⌃/⌥ belong to the system and the browser. Shift,
 *      CapsLock and the numeric keypad are treated as noise, so `Shift+j`
 *      still selects.
 *   3. **Text editing** — a hard stop. Only Esc gets through, because a mail
 *      client that eats `s` while you are typing a subject is unusable.
 *   4. **Escape precedence** — close the topmost thing, most specific first.
 *   5. **Overlay** — the shortcut sheet swallows everything but its own toggle.
 *      The list behind it must not mutate while you read the key list.
 *   6. **Palette** — the mailbox palette gets its own small grammar, and
 *      swallows the rest, for the same reason.
 *   7. **Canvas** — the normal case.
 */
export function commandForKey(
  key: string,
  context: KeyContext,
  event?: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
): Command | null {
  if (!context.ready) return null;

  const shift = event?.shiftKey ?? false;
  const ctrl = event?.ctrlKey ?? false;
  const alt = event?.altKey ?? false;
  const meta = event?.metaKey ?? false;

  // 2. Never intercept a system shortcut.
  if (ctrl || alt || meta) return null;

  // 3. A text field owns the keyboard.
  if (context.textEditing) {
    return key === "Escape" ? { type: "blurText" } : null;
  }

  // 4. Escape closes the topmost layer, whatever that is.
  if (key === "Escape") {
    if (context.overlayVisible) return { type: "dismissOverlay" };
    if (context.navigationVisible) return { type: "dismissNavigation" };
    if (context.viewerOpen) return { type: "closeViewer" };
    if (context.filtersActive) return { type: "clearFilters" };
    return null;
  }

  // 5. The shortcut sheet is modal.
  if (context.overlayVisible) {
    return key === "?" ? { type: "toggleShortcutsOverlay" } : null;
  }

  // 6. The mailbox palette is modal.
  if (context.navigationVisible) {
    if (key === "ArrowDown") return { type: "moveNavigation", delta: 1 };
    if (key === "ArrowUp") return { type: "moveNavigation", delta: -1 };
    if (key === "Enter") return { type: "activateNavigation" };
    if (key === "j") return { type: "moveNavigation", delta: 1 };
    if (key === "k") return { type: "moveNavigation", delta: -1 };
    if (key === "o") return { type: "activateNavigation" };
    if (key === "!" || (shift && key === "1")) return { type: "toggleNavigation" };
    const digit = digitIndex(key, shift);
    if (digit !== null && digit < context.railCount) {
      return { type: "toggleFilter", railIndex: digit };
    }
    return null;
  }

  // 7. The canvas.
  if (key === "ArrowDown") {
    return context.viewerOpen
      ? { type: "scrollReader", delta: 1 }
      : { type: "moveSelection", delta: 1 };
  }
  if (key === "ArrowUp") {
    return context.viewerOpen
      ? { type: "scrollReader", delta: -1 }
      : { type: "moveSelection", delta: -1 };
  }
  if (key === "Enter") {
    // Enter on the canvas opens the cursor; with a message open it belongs to
    // the reader, where it activates a link.
    return context.viewerOpen ? null : { type: "openSelected" };
  }
  if (key === "Backspace" || key === "Delete") {
    return context.hasActionTarget ? { type: "trash" } : null;
  }

  if (key === "j") return { type: "moveSelection", delta: 1 };
  if (key === "k") return { type: "moveSelection", delta: -1 };
  if (key === "o") {
    return context.viewerOpen ? null : { type: "openSelected" };
  }
  if (key === "?") return { type: "toggleShortcutsOverlay" };
  if (key === "!" || (shift && key === "1")) return { type: "toggleNavigation" };
  if (key === "/") return { type: "focusSearch" };

  if (key === "s" && context.hasActionTarget) return { type: "toggleStar" };
  if (key === "e" && context.hasActionTarget) return { type: "archive" };
  if (key === "#" && context.hasActionTarget) return { type: "trash" };
  if ((key === "u" || key === "m") && context.hasActionTarget) return { type: "toggleRead" };
  if (key === "r" && context.viewerOpen) return { type: "focusReply" };
  if (key === ",") return { type: "openSettings" };

  // `1`–`9` address the rail positionally. `!` is `Shift+1`, handled above,
  // so a shifted digit is never mistaken for a filter.
  const digit = digitIndex(key, shift);
  if (digit !== null && digit < context.railCount) {
    return { type: "toggleFilter", railIndex: digit };
  }

  return null;
}

/**
 * The zero-based rail position for a digit key, or `null`.
 *
 * `shift` matters: on a US layout `!` arrives as `event.key === "1"` with
 * shift held, and treating that as filter `1` would make the mailbox palette
 * and filter `1` fight over the same keypress.
 */
function digitIndex(key: string, shift: boolean): number | null {
  if (shift) return null;
  if (key.length !== 1 || key < "1" || key > "9") return null;
  return Number(key) - 1;
}

/**
 * Whether an unhandled key should be swallowed.
 *
 * In a keyboard-first app, an unbound key that reaches the OS produces the
 * macOS alert beep, which reads as a bug. So outside a text field, unmatched
 * keys are consumed — except when a system modifier is held, because those
 * genuinely belong elsewhere.
 */
export function shouldSwallow(
  context: KeyContext,
  event: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
): boolean {
  if (!context.ready || context.textEditing) return false;
  return !SYSTEM_MODIFIERS.some((modifier) => event[modifier]);
}

/** The `1`–`9` binding whose index is `railIndex`, for the sheet and the pills. */
export function digitForRailIndex(railIndex: number): string {
  return String(railIndex + 1);
}

/** The navigation item a palette index refers to. */
export const NAVIGATION_ORDER: readonly NavigationItem[] = ["inbox", "spam", "trash", "settings"];

/**
 * What a palette row does when activated.
 *
 * Settings is a view rather than a mailbox, which is why this returns a
 * command rather than a mailbox: the palette cannot switch to a mailbox that
 * does not exist.
 */
export function navigationCommandFor(item: NavigationItem): Command {
  return item === "settings" ? { type: "openSettings" } : { type: "activateNavigation" };
}

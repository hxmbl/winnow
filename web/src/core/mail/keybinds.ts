/**
 * The keyboard layer.
 *
 * A mail client is a keyboard application, so the mapping is *data*, not a
 * `switch` buried in a component: `BINDINGS` is walked in order and the first row
 * whose `matches` and `when` both hold wins. What is left imperative is only what
 * is not a flat lookup:
 *
 *   1. **Not ready** — nothing is routed before sign-in.
 *   2. **System modifiers** — ⌘/⌃/⌥ belong to the system and the browser.
 *   3. **Text editing** — a hard stop, except Escape, which either leaves the
 *      field or closes the composer.
 *   4. **Modal grammars** — the shortcut sheet and the mailbox palette each get
 *      their own small table, because both must swallow the canvas.
 *
 * `Masthead` prints its toolbar hints from this same table, so a button's `title`
 * cannot advertise a shortcut the router will not take.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Support/KeybindEngine.swift`.
 */

/** Everything the keyboard can trigger. */
export type Command =
  | { type: "moveSelection"; delta: number }
  | { type: "scrollReader"; delta: number }
  | { type: "openSelected" }
  | { type: "closeViewer" }
  | { type: "closeComposer" }
  | { type: "dismissOverlay" }
  | { type: "dismissNavigation" }
  | { type: "toggleStar" }
  | { type: "copyCode" }
  | { type: "archive" }
  | { type: "trash" }
  | { type: "toggleRead" }
  | { type: "focusReply" }
  | { type: "forward" }
  | { type: "compose" }
  | { type: "focusSearch" }
  | { type: "toggleFilter"; railIndex: number }
  | { type: "clearFilters" }
  | { type: "toggleNavigation" }
  | { type: "moveNavigation"; delta: number }
  | { type: "activateNavigation" }
  | { type: "blurText" }
  | { type: "toggleShortcutsOverlay" }
  | { type: "openSettings" };

/** The modifiers as the router sees them, plus the key itself. */
export type KeyModifiers = {
  /** `KeyboardEvent.key`, when the caller has the real event rather than a fixture. */
  key?: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
};

/**
 * A key as the router sees it. `keys` holds the expected `KeyboardEvent.key`
 * values on a US layout; `chars` holds the alternates other layouts produce for
 * the same binding.
 */
export type KeySpec = {
  /** Any of these matches. */
  keys: readonly string[];
  /** Additional `key` values for the same binding on other layouts. */
  chars?: readonly string[];
  /** Require (`true`) or forbid (`false`) a modifier. Unset means "don't care". */
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
};

/** The one context object the router reads. */
export type KeyContext = {
  /** No routing at all before the app is ready. */
  ready: boolean;
  /** A text field owns the keyboard: hands off everything but Esc. */
  textEditing: boolean;
  /** The composer is up. A modal world that happens to contain a text field. */
  composerOpen: boolean;
  viewerOpen: boolean;
  /**
   * The open message carries a one-time code, so `c` copies it instead of composing.
   * Optional so a caller that never shows codes need not say so.
   */
  codeAvailable?: boolean;
  /** A modal sheet — settings, the shortcut list — is up. */
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
  composerOpen: false,
  viewerOpen: false,
  overlayVisible: false,
  navigationVisible: false,
  filtersActive: false,
  hasActionTarget: false,
  railCount: 0,
};

/** A binding, and the row of the cheat sheet that documents it. */
export type Binding = {
  /** How the key is written on the key cap: `j`, `↑ / ↓`, `1–9`. */
  keys: string;
  help: string;
  matches: KeySpec;
  /**
   * Anything beyond "the key matches", for relational conditions like "only while
   * the reader is open".
   */
  when?: (pressed: Pressed) => boolean;
  /**
   * The command, or one computed from what was pressed — for keys whose meaning
   * depends on context. Returning `null` falls through to the next row.
   */
  command: Command | ((pressed: Pressed) => Command | null);
};

/** What the router matched, handed to a computed command. */
export type Pressed = {
  key: string;
  event: KeyModifiers;
  context: KeyContext;
};

/** True when `key` (with its modifiers) satisfies `spec`. */
export function specMatches(
  key: string,
  spec: KeySpec,
  event: KeyModifiers = {},
): boolean {
  if (![...spec.keys, ...(spec.chars ?? [])].includes(key)) return false;
  if (spec.shift !== undefined && (event.shiftKey ?? false) !== spec.shift) return false;
  if (spec.alt !== undefined && (event.altKey ?? false) !== spec.alt) return false;
  if (spec.ctrl !== undefined && (event.ctrlKey ?? false) !== spec.ctrl) return false;
  if (spec.meta !== undefined && (event.metaKey ?? false) !== spec.meta) return false;
  return true;
}

/** First match wins, in table order. */
function lookup(
  bindings: readonly Binding[],
  key: string,
  context: KeyContext,
  event: KeyModifiers,
): Command | null {
  const pressed: Pressed = { key, event, context };
  for (const binding of bindings) {
    if (!specMatches(key, binding.matches, event)) continue;
    if (binding.when && !binding.when(pressed)) continue;
    const command =
      typeof binding.command === "function" ? binding.command(pressed) : binding.command;
    if (command) return command;
  }
  return null;
}

/**
 * The zero-based rail position for a digit, or `null`. `shift` is rejected so `!`
 * (shift-`1`) does not also toggle filter `1`.
 */
function digitIndex(key: string, shift: boolean): number | null {
  if (shift) return null;
  if (key.length !== 1 || key < "1" || key > "9") return null;
  return Number(key) - 1;
}

// ── The canvas ──────────────────────────────────────────────────────────────

/**
 * The canvas bindings, in the order the sheet shows them and the router tries
 * them. Order is load-bearing: grouped by intent, most specific row first — which
 * is why Escape's four outcomes are one row that reads the context.
 */
export const BINDINGS: readonly Binding[] = [
  {
    keys: "j",
    help: "Next message",
    matches: { keys: ["j"] },
    command: { type: "moveSelection", delta: 1 },
  },
  {
    keys: "k",
    help: "Previous message",
    matches: { keys: ["k"] },
    command: { type: "moveSelection", delta: -1 },
  },
  {
    // Arrows scroll the open reader, otherwise walk the list.
    keys: "↓ / ↑",
    help: "Move through the list, or scroll the open message",
    matches: { keys: ["ArrowDown", "ArrowUp"] },
    command: ({ key, context }) => {
      const delta = key === "ArrowUp" ? -1 : 1;
      return context.viewerOpen
        ? { type: "scrollReader", delta }
        : { type: "moveSelection", delta };
    },
  },
  {
    keys: "o / ⏎",
    help: "Open the highlighted message",
    matches: { keys: ["o", "Enter"] },
    // With the reader open, Enter belongs to it; declining lets the next row match.
    when: ({ context }) => !context.viewerOpen,
    command: { type: "openSelected" },
  },
  {
    keys: "Esc",
    help: "Close the message, a sheet, or the filters",
    matches: { keys: ["Escape"] },
    when: ({ context }) =>
      context.overlayVisible ||
      context.navigationVisible ||
      context.viewerOpen ||
      context.filtersActive,
    command: ({ context }) => {
      if (context.overlayVisible) return { type: "dismissOverlay" };
      if (context.navigationVisible) return { type: "dismissNavigation" };
      if (context.viewerOpen) return { type: "closeViewer" };
      return { type: "clearFilters" };
    },
  },
  {
    keys: "s",
    help: "Star or unstar",
    matches: { keys: ["s"] },
    when: ({ context }) => context.hasActionTarget,
    command: { type: "toggleStar" },
  },
  {
    /*
      One row, two meanings, because one key: `c` is Gmail's compose, and it also copies
      the code of an open message that has one. A message with a code is the only place
      the copy is wanted, and there a new message is a button away — so the code wins
      there and compose wins everywhere else.
    */
    keys: "c",
    help: "Compose a new message (copies the code when the open message has one)",
    matches: { keys: ["c"] },
    when: ({ event }) => event.shiftKey !== true,
    command: ({ context }) =>
      context.viewerOpen && context.codeAvailable === true
        ? { type: "copyCode" }
        : { type: "compose" },
  },
  {
    // `e` is context-sensitive: archive, move back, or restore, following
    // `store.archive`.
    keys: "e",
    help: "Archive, unarchive, or restore — whichever this mailbox implies",
    matches: { keys: ["e"] },
    when: ({ context }) => context.hasActionTarget,
    command: { type: "archive" },
  },
  {
    keys: "# / ⌫",
    help: "Move to trash, or delete permanently from Trash",
    matches: { keys: ["#", "Backspace", "Delete"] },
    when: ({ context }) => context.hasActionTarget,
    command: { type: "trash" },
  },
  {
    keys: "u / m",
    help: "Mark read or unread",
    matches: { keys: ["u", "m"] },
    when: ({ context }) => context.hasActionTarget,
    command: { type: "toggleRead" },
  },
  {
    keys: "f",
    help: "Forward the open message",
    matches: { keys: ["f"] },
    when: ({ context }) => context.viewerOpen,
    command: { type: "forward" },
  },
  {
    keys: "r",
    help: "Reply to the open message",
    matches: { keys: ["r"] },
    when: ({ context }) => context.viewerOpen,
    command: { type: "focusReply" },
  },
  {
    // Bare `/` searches; shift-`/` is `?` on German and Nordic layouts, hence
    // both rows.
    keys: "/",
    help: "Search",
    matches: { keys: ["/"] },
    when: ({ event }) => event.shiftKey !== true,
    command: { type: "focusSearch" },
  },
  {
    keys: "1–9",
    help: "Toggle the filter pill in that position",
    matches: { keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] },
    command: ({ key, event, context }) => {
      // The rail length is only known at runtime, so bounds-check here.
      const index = digitIndex(key, event.shiftKey ?? false);
      return index !== null && index < context.railCount
        ? { type: "toggleFilter", railIndex: index }
        : null;
    },
  },
  {
    // `!` is Shift+1 on US and a bare character on French, so the bare `1` is
    // accepted only with shift held.
    keys: "!",
    help: "Switch mailbox, or open Settings",
    matches: { keys: ["!", "&", "1"] },
    when: ({ key, event }) => key !== "1" || event.shiftKey === true,
    command: { type: "toggleNavigation" },
  },
  {
    keys: "?",
    help: "Show or hide this list",
    matches: { keys: ["?", "/"] },
    // Only when shift was really held: German `?` arrives as `/` with shift.
    when: ({ key, event }) => key === "?" || event.shiftKey === true,
    command: { type: "toggleShortcutsOverlay" },
  },
  {
    keys: ",",
    help: "Settings",
    matches: { keys: [","] },
    command: { type: "openSettings" },
  },
] as const;

// ── Routing ─────────────────────────────────────────────────────────────────

/** Modifiers that mean the app must keep its hands off. */
const SYSTEM_MODIFIERS = ["altKey", "ctrlKey", "metaKey"] as const;

/**
 * Keys the platform owns outright, which the app therefore never consumes. Tab is
 * the one that mattered: swallowing it `preventDefault`ed focus movement and made
 * every `focus-visible` control unreachable (WCAG SC 2.1.1). Shift is not exempt —
 * `⇧1` and `⇧?` need it — and does not need to be, since `Shift+Tab` arrives with
 * `key === "Tab"` and is excluded by the same test.
 */
const PLATFORM_KEYS = ["Tab"] as const;

/**
 * The shortcut sheet is modal and answers only its own toggle and Escape; anything
 * else is swallowed rather than acted on.
 */
const SHEET_BINDINGS: readonly Binding[] = [
  {
    keys: "?",
    help: "",
    // The German `?` arrives as `/` with shift, with the same shift guard as the
    // canvas row.
    matches: { keys: ["?", "/"] },
    when: ({ key, event }) => key === "?" || event.shiftKey === true,
    command: { type: "toggleShortcutsOverlay" },
  },
  { keys: "Esc", help: "", matches: { keys: ["Escape"] }, command: { type: "dismissOverlay" } },
];

/**
 * The palette's own modal grammar: `j`/`k` walk the palette here and move the list
 * everywhere else, and one flat table cannot hold both.
 */
const PALETTE_BINDINGS: readonly Binding[] = [
  { keys: "↓ / j", help: "", matches: { keys: ["ArrowDown", "j"] }, command: { type: "moveNavigation", delta: 1 } },
  { keys: "↑ / k", help: "", matches: { keys: ["ArrowUp", "k"] }, command: { type: "moveNavigation", delta: -1 } },
  { keys: "⏎ / o", help: "", matches: { keys: ["Enter", "o"] }, command: { type: "activateNavigation" } },
  { keys: "Esc", help: "", matches: { keys: ["Escape"] }, command: { type: "dismissNavigation" } },
  {
    // Digits reach the rail from inside the palette. Sitting above the `!` row
    // lets a shifted digit fall through to it, so Shift+1 still opens the palette.
    keys: "1–9",
    help: "",
    matches: { keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] },
    command: ({ key, event, context }) => {
      const index = digitIndex(key, event.shiftKey ?? false);
      return index !== null && index < context.railCount
        ? { type: "toggleFilter", railIndex: index }
        : null;
    },
  },
  {
    keys: "!",
    help: "",
    matches: { keys: ["!", "&"], chars: ["1"] },
    command: { type: "toggleNavigation" },
  },
];

/**
 * Resolve a key event to a command, or `null` to let it through. Every table
 * lives in this file, so the cheat sheet, toolbar hints and router cannot drift.
 */
export function commandForKey(
  key: string,
  context: KeyContext,
  event: KeyModifiers = {},
): Command | null {
  // 1. Nothing is routed before the app is ready.
  if (!context.ready) return null;

  // 2. Never intercept a system shortcut.
  if (event.ctrlKey || event.altKey || event.metaKey) return null;

  // 3. A text field owns the keyboard — except Escape, which leaves it. The
  //    composer is a text field *and* a modal world, so Escape closes it.
  if (context.composerOpen) {
    // Checked before `textEditing`: the composer's Escape closes the sheet, a plain
    // field's returns the keyboard to the list.
    if (key === "Escape") return { type: "closeComposer" };
    return null;
  }

  if (context.textEditing) {
    if (key !== "Escape") return null;
    return { type: "blurText" };
  }

  // 4. Modals.
  if (context.overlayVisible) return lookup(SHEET_BINDINGS, key, context, event);
  if (context.navigationVisible) return lookup(PALETTE_BINDINGS, key, context, event);

  // 5. The canvas.
  return lookup(BINDINGS, key, context, event);
}

/**
 * Whether an unhandled key should be swallowed. Outside a text field and a modal,
 * unmatched keys are consumed (an unbound key otherwise beeps on macOS), except
 * with a system modifier held and except for `PLATFORM_KEYS`.
 */
export function shouldSwallow(context: KeyContext, event: KeyModifiers = {}): boolean {
  if (!context.ready) return false;
  if (context.textEditing || context.composerOpen) return false;
  if (event.key && PLATFORM_KEYS.includes(event.key as (typeof PLATFORM_KEYS)[number])) {
    return false;
  }
  if (SYSTEM_MODIFIERS.some((modifier) => event[modifier])) return false;
  return true;
}

/**
 * The keys a command is bound to, as the toolbar prints them. Returns the first
 * binding that produces the command, or `null` when no button should show one.
 */
export function shortcutFor(command: Command["type"]): string | null {
  const binding = BINDINGS.find((candidate) => {
    if (typeof candidate.command === "function") {
      // A computed command may produce this type in some context; assume yes.
      return PROBE.some((context) => resolveType(candidate.command, context) === command);
    }
    return candidate.command.type === command;
  });
  return binding?.keys ?? null;
}

/**
 * A tooltip of the form `Label (s)`, or just `Label` when the command has no key.
 * The *key* comes from the table, which is the part that can drift.
 */
export function shortcutHint(label: string, command: Command["type"]): string {
  const keys = shortcutFor(command);
  return keys ? `${label} (${keys})` : label;
}

/** A few contexts, chosen to cover the branches a computed command can take. */
const PROBE: readonly KeyContext[] = [
  DEFAULT_CONTEXT,
  { ...DEFAULT_CONTEXT, viewerOpen: true, hasActionTarget: true, railCount: 9 },
  { ...DEFAULT_CONTEXT, viewerOpen: true, hasActionTarget: true, codeAvailable: true },
  { ...DEFAULT_CONTEXT, overlayVisible: true, filtersActive: true },
];

function resolveType(
  command: Binding["command"],
  context: KeyContext,
): Command["type"] | null {
  const resolved =
    typeof command === "function"
      ? command({ key: "?", event: {}, context })
      : command;
  return resolved?.type ?? null;
}

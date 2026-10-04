/**
 * The keyboard layer.
 *
 * A mail client is a keyboard application. Everything you do while triaging —
 * next message, star, archive, filter, search — has a key, and the point of
 * this module is that the mapping is *data*, not a `switch` buried in a
 * component.
 *
 * That claim used to be half true, which is worse than not making it. `BINDINGS`
 * existed, the cheat sheet rendered it, and a test asserted every advertised key
 * resolved — but the router was an `if`-chain that never read the table. The
 * sheet was documentation with a test attached, and the two drifted at once: `,`
 * opened Settings and appeared nowhere in the sheet, and the toolbar advertised
 * a `⇧U` that was not a binding at all.
 *
 * So the router is built from the table now. `BINDINGS` is walked in order and
 * the first row whose `matches` and `when` both hold wins. What is left
 * imperative is only what genuinely is not a flat lookup:
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
  | { type: "archive" }
  | { type: "trash" }
  | { type: "toggleRead" }
  | { type: "markAllRead" }
  | { type: "focusReply" }
  | { type: "forward" }
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
 * A key as the router sees it.
 *
 * `keys` holds the values `KeyboardEvent.key` is expected to take on a US layout.
 * `chars` holds the alternates that produce the same binding on layouts where
 * the character is not the US one — `?` is `,` on a French keyboard and `Shift+/`
 * on a German one, and a cheat sheet that works on the author's machine only is
 * not a cheat sheet.
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
   * Anything beyond "the key matches".
   *
   * A predicate rather than more boolean fields because the interesting
   * conditions are relational — "only while the reader is open", "only when
   * something is selected" — and encoding those as flags means either a
   * combinatorial explosion of fields or a convention for smuggling a function
   * through a string.
   */
  when?: (pressed: Pressed) => boolean;
  /**
   * The command, or one computed from what was pressed.
   *
   * The computed form is what lets a single table row cover a key whose meaning
   * depends on context — the arrows scroll or move, Escape closes four different
   * things, and a digit addresses whichever pill it names. Returning `null` means
   * "not applicable after all", which is how the lookup falls through to the next
   * row rather than committing.
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
 * The zero-based rail position for a digit, or `null`.
 *
 * `shift` is rejected rather than merely deprioritised: on a US layout `!`
 * arrives as `event.key === "1"` with shift held, and treating that as filter `1`
 * would make the mailbox palette and filter `1` fight over one keypress.
 */
function digitIndex(key: string, shift: boolean): number | null {
  if (shift) return null;
  if (key.length !== 1 || key < "1" || key > "9") return null;
  return Number(key) - 1;
}

// ── The canvas ──────────────────────────────────────────────────────────────

/**
 * The canvas bindings, in the order the sheet shows them and the order the router
 * tries them.
 *
 * Order is load-bearing and deliberately not alphabetical. It is grouped as "how
 * do I move", "what do I do", "how do I change what I am looking at", and within
 * a group the more specific row comes first — which is why Escape's four outcomes
 * are one row that reads the context rather than four near-identical rows.
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
    // The one genuinely dual-purpose key pair. With a message open the reader is
    // what the user is looking at, so the arrows scroll it; with nothing open
    // they walk the list. `block: "nearest"` scrolling on the list keeps that
    // from turning into a jump.
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
    // With a message open, Enter belongs to the reader, where it would activate
    // a link. Declining rather than returning something else is what makes the
    // following row reachable.
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
    // `e` is context-sensitive rather than having a second binding: archive from
    // the inbox, move back from the archive, restore from the bin. One key, one
    // meaning, and the meaning follows where you are — which is also what
    // `store.archive` implements.
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
    // Bare `/` searches, and `/` with shift is `?` on a German or Nordic layout —
    // which is why the guard is on shift rather than on the character. Both rows
    // therefore have to be here, and both have to agree about shift.
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
      // The rail's length is only known at runtime, so the bounds check lives
      // here rather than in the table: `7` with six pills must fall through to
      // nothing, not to pill zero.
      const index = digitIndex(key, event.shiftKey ?? false);
      return index !== null && index < context.railCount
        ? { type: "toggleFilter", railIndex: index }
        : null;
    },
  },
  {
    // `!` is `Shift+1` on a US layout and a bare character on a French one, so
    // the bare `1` is accepted only with shift held — otherwise filter `1` and the
    // palette would fight over one keypress.
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
    // Only when shift really was held. On a US layout `?` arrives as `?`, on a
    // German one as `/`; in both cases `event.shiftKey` is true, and without this
    // guard the German `?` would be indistinguishable from the US search key.
    when: ({ key, event }) => key === "?" || event.shiftKey === true,
    command: { type: "toggleShortcutsOverlay" },
  },
  {
    keys: ",",
    help: "Settings",
    matches: { keys: [","] },
    command: { type: "openSettings" },
  },
  {
    // Shift, because it is the most destructive thing on the canvas: there is no
    // undo for "everything in this mailbox is now read". `U` rather than `u`,
    // which is already the read/unread toggle.
    keys: "⇧U",
    help: "Mark everything in this mailbox read",
    matches: { keys: ["U"], shift: true },
    command: { type: "markAllRead" },
  },
] as const;

// ── Routing ─────────────────────────────────────────────────────────────────

/** Modifiers that mean the app must keep its hands off. */
const SYSTEM_MODIFIERS = ["altKey", "ctrlKey", "metaKey"] as const;

/**
 * Keys the platform owns outright, which this app therefore never consumes.
 *
 * `Tab` is here because it was the one omission with a real cost, and the cost was
 * invisible from the source: every control in the app carries a `focus-visible`
 * ring, which is a promise that the control can be *reached*. Tab is unbound, so it
 * fell through to the swallow below and was `preventDefault`ed on the canvas —
 * which does not stop focus moving silently, it stops it dead. Every one of those
 * rings was a ring that could not be seen, the row star and the filter-pill mute
 * control were mouse-only, and the three `role="switch"` toggles in Settings could
 * not be operated from the keyboard at all. That is WCAG SC 2.1.1, and it was
 * caused by the one rule in this file written for a different reason.
 *
 * Shift is not a system modifier and must not become one: it is how `⇧U` and the
 * `⇧1` mailbox row are typed, so exempting it would cost real bindings. It does
 * not need exempting anyway, because `Shift+Tab` arrives here with `key === "Tab"`
 * and is excluded by the same test.
 *
 * `Tab` is exempt rather than bound on purpose. Binding it to a command would move
 * focus and also fire that command, which is worse than either. `Overlay` still
 * traps it at the edges of a dialog, which is the one place wrapping is correct.
 */
const PLATFORM_KEYS = ["Tab"] as const;

/**
 * The shortcut sheet is modal and answers only its own toggle and Escape.
 *
 * Anything else is swallowed rather than acted on: a keystroke that changes the
 * list behind a sheet the user is reading is a keystroke they did not mean.
 */
const SHEET_BINDINGS: readonly Binding[] = [
  {
    keys: "?",
    help: "",
    // The German `?` arrives as `/` with shift, so the alternate spelling comes
    // along — but the same shift guard as the canvas row, or a bare `/` typed at
    // the sheet would close it instead of being swallowed.
    matches: { keys: ["?", "/"] },
    when: ({ key, event }) => key === "?" || event.shiftKey === true,
    command: { type: "toggleShortcutsOverlay" },
  },
  { keys: "Esc", help: "", matches: { keys: ["Escape"] }, command: { type: "dismissOverlay" } },
];

/**
 * The palette's own grammar.
 *
 * Separate from `BINDINGS` because it is modal: `j`/`k` walk the palette here and
 * move the list everywhere else, and one flat table cannot hold both.
 */
const PALETTE_BINDINGS: readonly Binding[] = [
  { keys: "↓ / j", help: "", matches: { keys: ["ArrowDown", "j"] }, command: { type: "moveNavigation", delta: 1 } },
  { keys: "↑ / k", help: "", matches: { keys: ["ArrowUp", "k"] }, command: { type: "moveNavigation", delta: -1 } },
  { keys: "⏎ / o", help: "", matches: { keys: ["Enter", "o"] }, command: { type: "activateNavigation" } },
  { keys: "Esc", help: "", matches: { keys: ["Escape"] }, command: { type: "dismissNavigation" } },
  {
    // Digits reach the rail from inside the palette.
    //
    // This is why the palette matched a bare `1` at all, and why that was a bug:
    // the row that opened the palette was also the row that filtered, so `1` did
    // both. Splitting them means the palette's `!` demands shift for its digit
    // spelling and its own row takes the bare one — two keys, two answers, instead
    // of one key with two.
    //
    // It sits *above* the `!` row so a shifted digit reaches it and is declined
    // (`digitIndex` rejects shift), falling through to `!` — which is what makes
    // Shift+1 still open the palette.
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
 * Resolve a key event to a command, or `null` to let it through.
 *
 * Everything below the four rules is a table lookup, and every table lives in
 * this file, so the cheat sheet, the toolbar hints and the router cannot drift.
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
  //    composer is a text field *and* a modal world, so Escape closes it outright
  //    rather than blurring a textarea the user can no longer see.
  if (context.composerOpen) {
    // The composer is checked before `textEditing` even though it is also a text
    // field, because its Escape means "close the sheet" while a plain field's
    // means "give the keyboard back to the list". The order here is the whole
    // distinction; reversing it leaves the composer unclosable by keyboard.
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
 * Whether an unhandled key should be swallowed.
 *
 * In a keyboard-first app an unbound key that reaches the OS produces the macOS
 * alert beep, which reads as a bug. So outside a text field and outside a modal,
 * unmatched keys are consumed — except when a system modifier is held, because
 * those genuinely belong elsewhere, and except for `PLATFORM_KEYS`, which the
 * swallow must never reach.
 *
 * That last exemption is load-bearing rather than tidiness. "Consume everything
 * unmatched" is only safe while the unmatched set contains nothing anyone needs,
 * and `Tab` broke that: it does not beep, so nothing about the swallow was
 * protecting it, and cancelling it cost every focusable control in the app.
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
 * The keys a command is bound to, as the toolbar prints them.
 *
 * `Masthead` and `Reader` read this for their button tooltips, so a control's advertised
 * shortcut is by construction the one the router takes. It used to be the other way
 * round: every `title` was a hand-typed literal, and the cheat sheet's own comment
 * already described the resulting drift — `,` and `⇧U` were working in the app and
 * appeared nowhere, and a toolbar hint could name a key that did nothing.
 *
 * Returns the first binding that produces the command, or `null`. `null` is a real
 * answer: it means no button should print a shortcut for that command, and the caller
 * renders the label alone rather than an empty parenthesis.
 */
export function shortcutFor(command: Command["type"]): string | null {
  const binding = BINDINGS.find((candidate) => {
    if (typeof candidate.command === "function") {
      // A computed command can produce this type for *some* context; assume yes
      // rather than evaluating a context we do not have.
      return PROBE.some((context) => resolveType(candidate.command, context) === command);
    }
    return candidate.command.type === command;
  });
  return binding?.keys ?? null;
}

/**
 * A tooltip of the form `Label (s)`, or just `Label` when the command has no key.
 *
 * In the components rather than here because it is presentation — but the *key* comes
 * from the table, which is the part that can drift.
 */
export function shortcutHint(label: string, command: Command["type"]): string {
  const keys = shortcutFor(command);
  return keys ? `${label} (${keys})` : label;
}

/** A few contexts, chosen to cover the branches a computed command can take. */
const PROBE: readonly KeyContext[] = [
  DEFAULT_CONTEXT,
  { ...DEFAULT_CONTEXT, viewerOpen: true, hasActionTarget: true, railCount: 9 },
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

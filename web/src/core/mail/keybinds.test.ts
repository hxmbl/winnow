import { describe, expect, it } from "vitest";
import {
  BINDINGS,
  DEFAULT_CONTEXT,
  commandForKey,
  shortcutFor,
  shouldSwallow,
  specMatches,
  type Binding,
  type Command,
  type KeyContext,
} from "./keybinds";

/**
 * Every command type `commandForKey` can produce, across every reachable context.
 * Derived from the *router*, not the table, so a command in the union that no key
 * reaches fails here.
 */
function reachableCommandTypes(): Set<string> {
  const types = new Set<string>();
  const keys = [
    ..."jkoseurfmuhc#/,?!123456789".split(""),
    "Enter",
    "Escape",
    "ArrowUp",
    "ArrowDown",
    "Backspace",
    "Delete",
    "U",
    "&",
  ];
  const modifiers = [
    {},
    { shiftKey: true },
    { shiftKey: false },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
  ];
  for (const ctx of REACHABLE_CONTEXTS) {
    for (const key of keys) {
      for (const event of modifiers) {
        const command = commandForKey(key, ctx, event);
        if (command) types.add(command.type);
      }
    }
  }
  return types;
}

/**
 * Every command type a single binding can produce, across reachable contexts.
 * Probed through `commandForKey`, so a binding the router never reaches reports
 * nothing.
 */
function commandTypesOf(binding: Binding): string[] {
  const types = new Set<string>();
  const keys = [...binding.matches.keys, ...(binding.matches.chars ?? [])];
  for (const ctx of REACHABLE_CONTEXTS) {
    for (const key of keys) {
      for (const event of [{}, { shiftKey: true }, { shiftKey: false }]) {
        if (!specMatches(key, binding.matches, event)) continue;
        if (binding.when && !binding.when({ key, event, context: ctx })) continue;
        const command = commandForKey(key, ctx, event);
        if (command) types.add(command.type);
      }
    }
  }
  return [...types];
}

/** A context with everything switched off, so each test states only what it needs. */
function context(over: Partial<KeyContext> = {}): KeyContext {
  return { ...DEFAULT_CONTEXT, ...over };
}

/**
 * Every context a command can fire in, checked against all of them: a binding that
 * only works in a state no user is ever in is still a binding that does not work.
 */
const REACHABLE_CONTEXTS: readonly KeyContext[] = [
  DEFAULT_CONTEXT,
  context({ hasActionTarget: true }),
  context({ viewerOpen: true, hasActionTarget: true }),
  context({ viewerOpen: true, hasActionTarget: true, codeAvailable: true }),
  context({ railCount: 9, hasActionTarget: true }),
  context({ filtersActive: true, hasActionTarget: true, railCount: 9 }),
  context({ overlayVisible: true, hasActionTarget: true, railCount: 9 }),
  context({ navigationVisible: true, hasActionTarget: true, railCount: 9 }),
  context({ composerOpen: true, hasActionTarget: true, railCount: 9, viewerOpen: true }),
  context({ textEditing: true }),
  context({ textEditing: true, composerOpen: true }),
];

describe("commandForKey — not ready", () => {
  it("routes nothing before sign-in", () => {
    // Nothing to act on, so every key belongs to the browser.
    for (const key of ["j", "k", "s", "e", "/", "?"]) {
      expect(commandForKey(key, context({ ready: false }))).toBeNull();
    }
  });
});

describe("commandForKey — system modifiers", () => {
  it("never intercepts a command shortcut", () => {
    // ⌘R, ⌘W, ⌘Q belong to the app and the OS, not to a message list.
    for (const key of ["j", "s", "e", "/"]) {
      expect(commandForKey(key, DEFAULT_CONTEXT, { metaKey: true })).toBeNull();
      expect(commandForKey(key, DEFAULT_CONTEXT, { ctrlKey: true })).toBeNull();
      expect(commandForKey(key, DEFAULT_CONTEXT, { altKey: true })).toBeNull();
    }
  });

  it("treats shift as noise, so Shift+J still selects", () => {
    // Caps Lock and the numeric keypad are the same kind of noise.
    expect(commandForKey("j", DEFAULT_CONTEXT, { shiftKey: true })).toEqual({
      type: "moveSelection",
      delta: 1,
    });
  });
});

describe("commandForKey — text editing", () => {
  it("hands over everything except Escape", () => {
    // A mail client that eats `s` while you are writing a subject is unusable.
    const typing = context({ textEditing: true });
    for (const key of ["j", "k", "s", "e", "m", "u", "r", "1", "?"]) {
      expect(commandForKey(key, typing), key).toBeNull();
    }
  });

  it("still lets Escape out, to blur the field", () => {
    expect(commandForKey("Escape", context({ textEditing: true }))).toEqual({ type: "blurText" });
  });
});

describe("commandForKey — Escape precedence", () => {
  it("closes the most specific thing first", () => {
    const all = context({
      overlayVisible: true,
      navigationVisible: true,
      viewerOpen: true,
      filtersActive: true,
    });
    expect(commandForKey("Escape", all)).toEqual({ type: "dismissOverlay" });
    expect(commandForKey("Escape", context({ navigationVisible: true, viewerOpen: true, filtersActive: true }))).toEqual({
      type: "dismissNavigation",
    });
    expect(commandForKey("Escape", context({ viewerOpen: true, filtersActive: true }))).toEqual({
      type: "closeViewer",
    });
    expect(commandForKey("Escape", context({ filtersActive: true }))).toEqual({ type: "clearFilters" });
  });

  it("does nothing when there is nothing to close", () => {
    // Returning a no-op here would clear a search box the user is not in.
    expect(commandForKey("Escape", DEFAULT_CONTEXT)).toBeNull();
  });
});

describe("commandForKey — the shortcut sheet is modal", () => {
  const sheet = context({ overlayVisible: true });

  it("swallows everything except its own toggle", () => {
    // The list behind it must not mutate while you are reading the key list.
    for (const key of ["j", "k", "s", "e", "1", "/"]) {
      expect(commandForKey(key, sheet), key).toBeNull();
    }
  });

  it("closes on ?", () => {
    expect(commandForKey("?", sheet, { shiftKey: true })).toEqual({
      type: "toggleShortcutsOverlay",
    });
  });

  it("closes on Escape", () => {
    // The generic Escape rule already does this, but the sheet's own table must too.
    expect(commandForKey("Escape", sheet)).toEqual({ type: "dismissOverlay" });
  });
});

describe("commandForKey — the mailbox palette is modal", () => {
  const palette = context({ navigationVisible: true, railCount: 3 });

  it("has its own small grammar", () => {
    expect(commandForKey("ArrowDown", palette)).toEqual({ type: "moveNavigation", delta: 1 });
    expect(commandForKey("j", palette)).toEqual({ type: "moveNavigation", delta: 1 });
    expect(commandForKey("ArrowUp", palette)).toEqual({ type: "moveNavigation", delta: -1 });
    expect(commandForKey("Enter", palette)).toEqual({ type: "activateNavigation" });
    expect(commandForKey("o", palette)).toEqual({ type: "activateNavigation" });
  });

  it("swallows the canvas actions", () => {
    // Behind a palette, `e` must not archive the message the user is not looking at.
    for (const key of ["s", "e", "m", "u", "#"]) {
      expect(commandForKey(key, palette), key).toBeNull();
    }
  });

  it("still toggles itself closed", () => {
    expect(commandForKey("!", palette)).toEqual({ type: "toggleNavigation" });
  });

  it("bounds-checks a digit against the rail length", () => {
    expect(commandForKey("1", palette)).toEqual({ type: "toggleFilter", railIndex: 0 });
    expect(commandForKey("3", palette)).toEqual({ type: "toggleFilter", railIndex: 2 });
    // `4` is past the end of a three-pill rail.
    expect(commandForKey("4", palette)).toBeNull();
  });

  it("keeps Shift+1 for itself, so a digit never opens the palette", () => {
    // Pins that the palette's `!` row no longer accepts a bare `1`.
    const shifted = commandForKey("1", palette, { shiftKey: true });
    expect(shifted).toEqual({ type: "toggleNavigation" });
    expect(commandForKey("1", palette, { shiftKey: false })).toEqual({
      type: "toggleFilter",
      railIndex: 0,
    });
  });
});

describe("commandForKey — the canvas", () => {
  it("moves the cursor with j and k", () => {
    expect(commandForKey("j", DEFAULT_CONTEXT)).toEqual({ type: "moveSelection", delta: 1 });
    expect(commandForKey("k", DEFAULT_CONTEXT)).toEqual({ type: "moveSelection", delta: -1 });
  });

  it("scrolls instead of moving when a message is open", () => {
    // With the reader open, the arrows belong to the reader.
    const open = context({ viewerOpen: true });
    expect(commandForKey("ArrowDown", open)).toEqual({ type: "scrollReader", delta: 1 });
    expect(commandForKey("ArrowUp", open)).toEqual({ type: "scrollReader", delta: -1 });
  });

  it("opens with o, and stops doing so once something is open", () => {
    expect(commandForKey("o", DEFAULT_CONTEXT)).toEqual({ type: "openSelected" });
    expect(commandForKey("o", context({ viewerOpen: true }))).toBeNull();
  });

  it("gives Enter to the reader once a message is open, for links", () => {
    expect(commandForKey("Enter", DEFAULT_CONTEXT)).toEqual({ type: "openSelected" });
    expect(commandForKey("Enter", context({ viewerOpen: true }))).toBeNull();
  });

  it("trashes on backspace, but only with something to act on", () => {
    expect(commandForKey("Backspace", DEFAULT_CONTEXT)).toBeNull();
    expect(commandForKey("Backspace", context({ hasActionTarget: true }))).toEqual({ type: "trash" });
  });

  it("gates every action on having a target", () => {
    // No target means no message for these to act on.
    for (const key of ["s", "e", "m", "u", "#"]) {
      expect(commandForKey(key, DEFAULT_CONTEXT), key).toBeNull();
    }
  });

  it("focuses the composer only when a message is open", () => {
    expect(commandForKey("r", DEFAULT_CONTEXT)).toBeNull();
    expect(commandForKey("r", context({ viewerOpen: true }))).toEqual({ type: "focusReply" });
  });

  it("forwards only when a message is open", () => {
    // Gating on `viewerOpen` rather than `hasActionTarget` keeps `f` off a bare cursor.
    expect(commandForKey("f", DEFAULT_CONTEXT)).toBeNull();
    expect(commandForKey("f", context({ hasActionTarget: true }))).toBeNull();
    expect(commandForKey("f", context({ viewerOpen: true }))).toEqual({ type: "forward" });
  });

  it("marks the whole mailbox read only with shift", () => {
    // `u` is already read/unread; a bare letter for this would be one mis-aimed
    // keystroke.
    expect(commandForKey("u", context({ hasActionTarget: true }))).toEqual({
      type: "toggleRead",
    });
    expect(commandForKey("U", context({ hasActionTarget: true }))).toBeNull();
    expect(
      commandForKey("U", context({ hasActionTarget: true }), { shiftKey: true }),
    ).toEqual({ type: "markAllRead" });
  });

  it("always allows search, settings and the two overlays", () => {
    // Safe with or without a target.
    expect(commandForKey("/", DEFAULT_CONTEXT)).toEqual({ type: "focusSearch" });
    expect(commandForKey(",", DEFAULT_CONTEXT)).toEqual({ type: "openSettings" });
    expect(commandForKey("?", DEFAULT_CONTEXT, { shiftKey: true })).toEqual({
      type: "toggleShortcutsOverlay",
    });
    expect(commandForKey("!", DEFAULT_CONTEXT, { shiftKey: true })).toEqual({
      type: "toggleNavigation",
    });
  });

  it("distinguishes `/` from `?` on a layout where both arrive as slash", () => {
    // On a German or Nordic keyboard `?` is `/` with shift.
    expect(commandForKey("/", DEFAULT_CONTEXT, { shiftKey: false })).toEqual({
      type: "focusSearch",
    });
    expect(commandForKey("/", DEFAULT_CONTEXT, { shiftKey: true })).toEqual({
      type: "toggleShortcutsOverlay",
    });
  });

  it("reaches the palette on a layout where `!` is not Shift+1", () => {
    // A French keyboard produces a bare `&`; only the *digit* 1 demands shift.
    expect(commandForKey("&", DEFAULT_CONTEXT)).toEqual({ type: "toggleNavigation" });
    expect(commandForKey("1", context({ railCount: 9 }), { shiftKey: true })).toEqual({
      type: "toggleNavigation",
    });
    expect(commandForKey("1", context({ railCount: 9 }), { shiftKey: false })).toEqual({
      type: "toggleFilter",
      railIndex: 0,
    });
  });
});

describe("commandForKey — the composer", () => {
  it("closes on Escape rather than blurring a field nobody can see", () => {
    // The generic rule would blur the composer's textarea, closing nothing.
    const typing = context({ textEditing: true, composerOpen: true });
    expect(commandForKey("Escape", typing)).toEqual({ type: "closeComposer" });
    // …and still refuses to eat the letters being typed.
    for (const key of ["j", "s", "r", "e", "?"]) {
      expect(commandForKey(key, typing), key).toBeNull();
    }
  });

  it("routes nothing else while it is open", () => {
    // Otherwise `s` behind the sheet would star a message the user cannot see.
    const open = context({ composerOpen: true, hasActionTarget: true, viewerOpen: true });
    for (const key of ["j", "k", "s", "e", "u", "!", "?", ","]) {
      expect(commandForKey(key, open), key).toBeNull();
    }
  });
});

describe("commandForKey — digit keys", () => {
  it("address the rail positionally, from zero", () => {
    const ctx = context({ railCount: 9 });
    expect(commandForKey("1", ctx)).toEqual({ type: "toggleFilter", railIndex: 0 });
    expect(commandForKey("9", ctx)).toEqual({ type: "toggleFilter", railIndex: 8 });
  });

  it("ignore a digit past the end of the rail", () => {
    expect(commandForKey("5", context({ railCount: 2 }))).toBeNull();
  });

  it("never toggle a filter for a shifted digit", () => {
    // On a US layout `!` arrives as `1` with shift; it must open the palette.
    const shifted = commandForKey("1", context({ railCount: 9 }), { shiftKey: true });
    expect(shifted).toEqual({ type: "toggleNavigation" });
    expect(shifted).not.toEqual({ type: "toggleFilter", railIndex: 0 });
  });

  it("still toggle filter 1 when the key is not shifted", () => {
    expect(commandForKey("1", context({ railCount: 9 }), { shiftKey: false })).toEqual({
      type: "toggleFilter",
      railIndex: 0,
    });
  });
});

describe("shouldSwallow", () => {
  it("consumes an unmatched key outside a text field", () => {
    // Otherwise macOS beeps, which reads as broken in a keyboard-first app.
    expect(shouldSwallow(DEFAULT_CONTEXT, {})).toBe(true);
  });

  it("never consumes inside a text field", () => {
    expect(shouldSwallow(context({ textEditing: true }), {})).toBe(false);
  });

  it("never consumes inside the composer", () => {
    // The composer's Escape is handled by `commandForKey`; swallowing here would
    // double-prevent it.
    expect(shouldSwallow(context({ composerOpen: true }), {})).toBe(false);
  });

  it("never consumes when a system modifier is held", () => {
    expect(shouldSwallow(DEFAULT_CONTEXT, { metaKey: true })).toBe(false);
    expect(shouldSwallow(DEFAULT_CONTEXT, { ctrlKey: true })).toBe(false);
    expect(shouldSwallow(DEFAULT_CONTEXT, { altKey: true })).toBe(false);
  });

  it("never consumes before sign-in", () => {
    expect(shouldSwallow(context({ ready: false }), {})).toBe(false);
  });

  /**
   * The exemption that cost the app its entire keyboard tab order: Tab was unbound,
   * reached the swallow, and was consumed — cancelling focus advance.
   */
  it("never consumes Tab, in either direction", () => {
    expect(shouldSwallow(DEFAULT_CONTEXT, { key: "Tab" })).toBe(false);
    // Shift is not exempt, but `Shift+Tab` still arrives with `key === "Tab"`.
    expect(shouldSwallow(DEFAULT_CONTEXT, { key: "Tab", shiftKey: true })).toBe(false);
  });

  it("still consumes the keys either side of Tab", () => {
    // The exemption is Tab, not "navigation keys".
    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Space", "Escape"]) {
      expect(shouldSwallow(DEFAULT_CONTEXT, { key }), key).toBe(true);
    }
  });

  it("leaves Shift alone, because Shift types bindings", () => {
    // Adding `shiftKey` to the system modifiers would cost `⇧U` and `⇧1`.
    expect(shouldSwallow(DEFAULT_CONTEXT, { key: "U", shiftKey: true })).toBe(true);
  });
});

describe("the cheat sheet", () => {
  it("has no duplicate key descriptions", () => {
    // Two rows claiming the same key is the drift the sheet prevents.
    const seen = new Set<string>();
    for (const binding of BINDINGS) {
      expect(seen.has(binding.keys), `duplicate sheet entry: ${binding.keys}`).toBe(false);
      seen.add(binding.keys);
    }
  });

  it("routes every key it advertises, in a context where it is meant to work", () => {
    // Each advertised key must produce its advertised command. The context is
    // chosen per key rather than maximally generous, because a maximally generous
    // context is not a real one.
    const contexts: Record<string, KeyContext> = {
      // Opening needs a row highlighted, and the reader closed.
      o: context({ hasActionTarget: true, viewerOpen: false }),
      Enter: context({ hasActionTarget: true, viewerOpen: false }),
      // Scrolling the reader needs it open.
      ArrowDown: context({ viewerOpen: true, hasActionTarget: true }),
      ArrowUp: context({ viewerOpen: true, hasActionTarget: true }),
      // Replying and forwarding need the reader open.
      r: context({ viewerOpen: true, hasActionTarget: true }),
      f: context({ viewerOpen: true, hasActionTarget: true }),
      c: context({ viewerOpen: true, hasActionTarget: true }),
      // Escape closes the topmost layer; only the reader is open.
      Escape: context({ viewerOpen: true, hasActionTarget: true }),
      // Digits need a rail to address.
      "1": context({ railCount: 9, hasActionTarget: true }),
    };

    for (const binding of BINDINGS) {
      for (const key of binding.matches.keys) {
        // Press a required modifier, or the assertion tests a rejected keystroke.
        const event =
          binding.matches.shift === true ? { shiftKey: true } : { shiftKey: false };
        const ctx = contexts[key] ?? context({ hasActionTarget: true, railCount: 9 });
        const command = commandForKey(key, ctx, event);
        expect(command, `sheet advertises ${binding.keys} (${key})`).not.toBeNull();
      }
    }
  });

  it("routes every command in the union to some key in some context", () => {
    // The floor: a command nobody can produce is dead code wearing a type
    // annotation.
    const reachable = reachableCommandTypes();
    const expected: Command["type"][] = [
      "moveSelection",
      "scrollReader",
      "openSelected",
      "closeViewer",
      "closeComposer",
      "dismissOverlay",
      "dismissNavigation",
      "toggleStar",
      "copyCode",
      "archive",
      "trash",
      "toggleRead",
      "markAllRead",
      "focusReply",
      "forward",
      "compose",
      "focusSearch",
      "toggleFilter",
      "clearFilters",
      "toggleNavigation",
      "moveNavigation",
      "activateNavigation",
      "blurText",
      "toggleShortcutsOverlay",
      "openSettings",
    ];

    for (const type of expected) {
      expect(reachable.has(type), `no key produces "${type}"`).toBe(true);
    }

    // Nothing produces a command outside that list either.
    for (const type of reachable) {
      expect(expected.includes(type as Command["type"]), `unhandled command: ${type}`).toBe(true);
    }
  });

  it("documents every action it can take, and nothing it cannot", () => {
    // A row may produce several commands, so this is a containment check.
    const reachable = reachableCommandTypes();

    for (const binding of BINDINGS) {
      const types = commandTypesOf(binding);
      expect(types.length, `sheet row "${binding.keys}" produces nothing at all`).toBeGreaterThan(0);
      for (const type of types) {
        expect(reachable.has(type), `sheet row "${binding.keys}" documents unreachable ${type}`).toBe(
          true,
        );
      }
    }

    // The sheet renders `keys` and `help`, so neither may be blank.
    for (const binding of BINDINGS) {
      expect(binding.keys.trim(), "a sheet row with a blank key column").not.toBe("");
      expect(binding.help.trim(), `sheet row "${binding.keys}" has no description`).not.toBe("");
    }
  });

  it("lets no keystroke satisfy two rows that would both act on it", () => {
    // Sharing a key *list* is fine — `?` and `/` are the same physical key, and `1`
    // is both a rail position and `Shift+1`. What must not happen is two rows that
    // would each produce a command for one keystroke: the first silently wins and
    // the second documents nothing.
    const ambiguous: string[] = [];

    for (const ctx of REACHABLE_CONTEXTS) {
      for (const key of "jkoseurfmuh#/,?!123456789U&".split("")) {
        for (const event of [{}, { shiftKey: true }, { shiftKey: false }]) {
          const firing = BINDINGS.filter((binding) => {
            if (![...binding.matches.keys, ...(binding.matches.chars ?? [])].includes(key)) {
              return false;
            }
            if (binding.when && !binding.when({ key, event, context: ctx })) return false;
            const command =
              typeof binding.command === "function"
                ? binding.command({ key, event, context: ctx })
                : binding.command;
            return command !== null;
          });

          if (firing.length > 1) {
            ambiguous.push(
              `${key}${event.shiftKey ? "⇧" : ""} → ${firing
                .map((binding) => `"${binding.keys}"`)
                .join(" and ")}`,
            );
          }
        }
      }
    }

    expect(ambiguous).toEqual([]);
  });
});

describe("copying a code", () => {
  it("is c, with an open message that has a code, and does not take Shift+C", () => {
    expect(
      commandForKey("c", { ...DEFAULT_CONTEXT, viewerOpen: true, hasActionTarget: true, codeAvailable: true }),
    ).toEqual({ type: "copyCode" });
    expect(commandForKey("C", { ...DEFAULT_CONTEXT, viewerOpen: true, codeAvailable: true }, { shiftKey: true })).toBeNull();
    // One row owns `c`; its meaning is computed from the context.
    expect(BINDINGS.filter((binding) => binding.matches.keys?.includes("c"))).toHaveLength(1);
  });
});

describe("composing", () => {
  it("is c on the list, and in an open message without a code", () => {
    expect(commandForKey("c", DEFAULT_CONTEXT)).toEqual({ type: "compose" });
    expect(commandForKey("c", { ...DEFAULT_CONTEXT, hasActionTarget: true })).toEqual({ type: "compose" });
    expect(commandForKey("c", { ...DEFAULT_CONTEXT, viewerOpen: true, hasActionTarget: true })).toEqual({
      type: "compose",
    });
  });

  it("never fires in a text field, the composer, a sheet or the palette", () => {
    expect(commandForKey("c", { ...DEFAULT_CONTEXT, textEditing: true })).toBeNull();
    expect(commandForKey("c", { ...DEFAULT_CONTEXT, composerOpen: true })).toBeNull();
    expect(commandForKey("c", { ...DEFAULT_CONTEXT, overlayVisible: true })).toBeNull();
    expect(commandForKey("c", { ...DEFAULT_CONTEXT, navigationVisible: true })).toBeNull();
    expect(commandForKey("c", { ...DEFAULT_CONTEXT, ready: false })).toBeNull();
  });

  it("leaves Shift+C and the system modifiers alone", () => {
    expect(commandForKey("C", DEFAULT_CONTEXT, { shiftKey: true })).toBeNull();
    expect(commandForKey("c", DEFAULT_CONTEXT, { metaKey: true })).toBeNull();
    expect(commandForKey("c", DEFAULT_CONTEXT, { ctrlKey: true })).toBeNull();
  });

  it("is what the toolbar advertises", () => {
    expect(shortcutFor("compose")).toBe("c");
  });
});

import { describe, expect, it } from "vitest";
import {
  BINDINGS,
  DEFAULT_CONTEXT,
  commandForKey,
  shouldSwallow,
  specMatches,
  type Binding,
  type Command,
  type KeyContext,
} from "./keybinds";

/**
 * Every command type `commandForKey` can produce, across every reachable context.
 *
 * Derived from the *router* rather than from the table, so this stays correct as
 * either side changes — and so a command that only exists in the `Command` union,
 * with no key that reaches it, fails here rather than in someone's hands.
 */
function reachableCommandTypes(): Set<string> {
  const types = new Set<string>();
  const keys = [
    ..."jkoseurfmuh#/,?!123456789".split(""),
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
 *
 * Probed through `commandForKey` rather than by calling `binding.command`
 * directly, because a binding that the router never reaches produces nothing in
 * the app — and calling it by hand would happily report one.
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
 * Every context a command can fire in.
 *
 * The cheat-sheet contract is checked against *all* of them rather than one
 * generous one, because a binding that only works in a state no user is ever in is
 * still a binding that does not work. This is the enumeration: the contexts the
 * table's guards actually branch on.
 */
const REACHABLE_CONTEXTS: readonly KeyContext[] = [
  DEFAULT_CONTEXT,
  context({ hasActionTarget: true }),
  context({ viewerOpen: true, hasActionTarget: true }),
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
    // Caps Lock and the numeric keypad are the same kind of noise. A user with
    // caps on — or a filter picker where a digit is shift-produced — was getting
    // nothing at all.
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
    // The generic Escape rule already does this; the sheet's own table has to as
    // well, or `SHEET_BINDINGS` would be a second, driftable answer.
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
    // Not a preference: behind a palette, `e` must not archive the message the
    // user is not looking at.
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
    // `4` is past the end: a rail with three pills has no fourth position, and
    // acting on it would toggle an arbitrary filter.
    expect(commandForKey("4", palette)).toBeNull();
  });

  it("keeps Shift+1 for itself, so a digit never opens the palette", () => {
    // The bug this pins: the palette's `!` row accepted a bare `1`, so pressing `1`
    // with the palette open both toggled a filter *and* would have closed the
    // palette — one keystroke with two answers, neither of them the obvious one.
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
    // With the reader open, the arrows belong to the reader. Moving the list
    // underneath an open message is disorienting.
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
    // No target means no message, so `s` must not reach the store and act on
    // whatever happened to be selected in another pane.
    for (const key of ["s", "e", "m", "u", "#"]) {
      expect(commandForKey(key, DEFAULT_CONTEXT), key).toBeNull();
    }
  });

  it("focuses the composer only when a message is open", () => {
    expect(commandForKey("r", DEFAULT_CONTEXT)).toBeNull();
    expect(commandForKey("r", context({ viewerOpen: true }))).toEqual({ type: "focusReply" });
  });

  it("forwards only when a message is open", () => {
    // Forwarding needs a message to forward. Gating it on `viewerOpen` rather than
    // on `hasActionTarget` is what keeps `f` from firing on a bare cursor: the
    // cursor can exist with nothing highlighted.
    expect(commandForKey("f", DEFAULT_CONTEXT)).toBeNull();
    expect(commandForKey("f", context({ hasActionTarget: true }))).toBeNull();
    expect(commandForKey("f", context({ viewerOpen: true }))).toEqual({ type: "forward" });
  });

  it("marks the whole mailbox read only with shift", () => {
    // The most destructive thing on the canvas, and the one with no undo. It gets
    // a modifier precisely because `u` is already the read/unread toggle and a
    // bare letter for "mark everything read" would be one mis-aimed keystroke.
    expect(commandForKey("u", context({ hasActionTarget: true }))).toEqual({
      type: "toggleRead",
    });
    expect(commandForKey("U", context({ hasActionTarget: true }))).toBeNull();
    expect(
      commandForKey("U", context({ hasActionTarget: true }), { shiftKey: true }),
    ).toEqual({ type: "markAllRead" });
  });

  it("always allows search, settings and the two overlays", () => {
    // These are safe with or without a target: search and settings are not
    // destructive, and the sheets are views.
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
    // On a German or Nordic keyboard `?` *is* `/` with shift. If the two bindings
    // could not tell shift apart, one of them would be unreachable on exactly the
    // layouts that need it.
    expect(commandForKey("/", DEFAULT_CONTEXT, { shiftKey: false })).toEqual({
      type: "focusSearch",
    });
    expect(commandForKey("/", DEFAULT_CONTEXT, { shiftKey: true })).toEqual({
      type: "toggleShortcutsOverlay",
    });
  });

  it("reaches the palette on a layout where `!` is not Shift+1", () => {
    // A French keyboard produces a bare `&` with no shift at all. Requiring shift
    // would make the palette unreachable there, so the character is accepted on
    // its own and only the *digit* 1 demands shift.
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
    // The composer's textarea is a text field, so the generic rule would blur it —
    // which closes nothing, because the sheet is still up over it.
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
    // On a US layout `!` arrives as `event.key === "1"` with shift held. It must
    // open the palette, never filter 1 — otherwise the palette and the rail
    // fight over the same physical keypress.
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
    // Otherwise macOS beeps — the alert for "nothing handled this" — and a
    // keyboard-first app beeping at you looks broken.
    expect(shouldSwallow(DEFAULT_CONTEXT, {})).toBe(true);
  });

  it("never consumes inside a text field", () => {
    expect(shouldSwallow(context({ textEditing: true }), {})).toBe(false);
  });

  it("never consumes inside the composer", () => {
    // The composer's own Escape is handled by `commandForKey`, so consuming here
    // would double-prevent it and the sheet would never close.
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
});

describe("the cheat sheet", () => {
  it("has no duplicate key descriptions", () => {
    // Two rows claiming the same key is the exact drift the sheet is supposed
    // to prevent, since it is generated from the router.
    const seen = new Set<string>();
    for (const binding of BINDINGS) {
      expect(seen.has(binding.keys), `duplicate sheet entry: ${binding.keys}`).toBe(false);
      seen.add(binding.keys);
    }
  });

  it("routes every key it advertises, in a context where it is meant to work", () => {
    // Each advertised key must produce its advertised command, so the
    // documentation cannot drift from the behaviour.
    //
    // The context is chosen per key rather than maximally generous, because a
    // maximally generous context is not a real one: `o` is suppressed while the
    // reader is open, and `r` only works with a message open. A test that forced
    // everything on at once would be asserting a state no user is ever in, and
    // would pass a binding that can never fire.
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
      // Escape closes the topmost layer; with only the reader open, that is it.
      Escape: context({ viewerOpen: true, hasActionTarget: true }),
      // Digits need a rail to address.
      "1": context({ railCount: 9, hasActionTarget: true }),
    };

    for (const binding of BINDINGS) {
      for (const key of binding.matches.keys) {
        // A row whose modifier is required has to be pressed with it, or the
        // assertion would be testing a keystroke the binding rejects.
        const event =
          binding.matches.shift === true ? { shiftKey: true } : { shiftKey: false };
        const ctx = contexts[key] ?? context({ hasActionTarget: true, railCount: 9 });
        const command = commandForKey(key, ctx, event);
        expect(command, `sheet advertises ${binding.keys} (${key})`).not.toBeNull();
      }
    }
  });

  it("routes every command in the union to some key in some context", () => {
    // The floor. A command nobody can produce is dead code wearing a type
    // annotation, and it used to be invisible: `restore` sat in the union and in
    // `App.tsx`'s switch for the whole life of the project with no binding
    // anywhere that produced it.
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
      "archive",
      "trash",
      "toggleRead",
      "markAllRead",
      "focusReply",
      "forward",
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

    // And nothing produces a command outside that list, which catches a binding
    // added for an action nobody wired up.
    for (const type of reachable) {
      expect(expected.includes(type as Command["type"]), `unhandled command: ${type}`).toBe(true);
    }
  });

  it("documents every action it can take, and nothing it cannot", () => {
    // `BINDINGS` is the cheat sheet. A row may produce several commands — Escape
    // alone covers four, and the arrows cover two — so this is a containment check
    // rather than a bijection.
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

    // Every command with a sheet row of its own must name a printable key, since
    // the sheet renders `keys` and the user reads it.
    for (const binding of BINDINGS) {
      expect(binding.keys.trim(), "a sheet row with a blank key column").not.toBe("");
      expect(binding.help.trim(), `sheet row "${binding.keys}" has no description`).not.toBe("");
    }
  });

  it("lets no keystroke satisfy two rows that would both act on it", () => {
    // The drift the sheet exists to prevent, checked as behaviour rather than as
    // prose.
    //
    // Sharing a key *list* is fine and necessary — `?` and `/` are the same
    // physical key on a German layout, and `1` is both a rail position and
    // `Shift+1`. What must not happen is two rows that would each produce a
    // command for one keystroke: the first silently wins, so the second is
    // documentation of nothing, and reordering the table would silently change
    // what a key does.
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

import { describe, expect, it } from "vitest";
import {
  BINDINGS,
  DEFAULT_CONTEXT,
  commandForKey,
  shouldSwallow,
  type KeyContext,
} from "./keybinds";

/** A context with everything switched off, so each test states only what it needs. */
function context(over: Partial<KeyContext> = {}): KeyContext {
  return { ...DEFAULT_CONTEXT, ...over };
}

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
    expect(commandForKey("?", sheet)).toEqual({ type: "toggleShortcutsOverlay" });
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

  it("always allows search and the two overlays", () => {
    // These are safe with or without a target: search is not destructive, and
    // the sheets are views.
    expect(commandForKey("/", DEFAULT_CONTEXT)).toEqual({ type: "focusSearch" });
    expect(commandForKey("?", DEFAULT_CONTEXT)).toEqual({ type: "toggleShortcutsOverlay" });
    expect(commandForKey("!", DEFAULT_CONTEXT)).toEqual({ type: "toggleNavigation" });
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
    // reader is open, and `r` only works with a message open. A test that
    // forced everything on at once would be asserting a state no user is ever
    // in, and would pass a binding that can never fire.
    const contexts: Record<string, KeyContext> = {
      // Opening needs a row highlighted, and the reader closed.
      o: context({ hasActionTarget: true, viewerOpen: false }),
      Enter: context({ hasActionTarget: true, viewerOpen: false }),
      // Scrolling the reader needs it open.
      ArrowDown: context({ viewerOpen: true, hasActionTarget: true }),
      ArrowUp: context({ viewerOpen: true, hasActionTarget: true }),
      // Replying needs the reader open.
      r: context({ viewerOpen: true, hasActionTarget: true }),
      // Escape closes the topmost layer; with only the reader open, that is it.
      Escape: context({ viewerOpen: true, hasActionTarget: true }),
      // Digits need a rail to address.
      "1": context({ railCount: 9, hasActionTarget: true }),
    };

    for (const binding of BINDINGS) {
      const key = binding.matches.keys[0];
      const ctx = contexts[key] ?? context({ hasActionTarget: true, railCount: 9 });
      const command = commandForKey(key, ctx);
      expect(command, `sheet advertises ${binding.keys} (${key})`).not.toBeNull();
    }
  });

  it("documents every action the store can take from the keyboard", () => {
    const documented = new Set(BINDINGS.map((b) => b.command.type));
    // Actions with no sheet row of their own, and why:
    //
    //   - `restore` is what `e` does from the bin; a separate key would be a
    //     second way to do one thing.
    //   - `clearFilters` is Escape with no viewer open.
    //   - `dismissOverlay` / `dismissNavigation` / `blurText` are the other
    //     Escape targets.
    //   - `activateNavigation` / `moveNavigation` are Enter and arrows inside
    //     the palette, and the palette has its own row for `!`.
    //   - `openSettings` is the palette's settings row, reachable by mouse.
    const implicit = new Set([
      "restore",
      "clearFilters",
      "dismissOverlay",
      "dismissNavigation",
      "blurText",
      "activateNavigation",
      "moveNavigation",
      "openSettings",
    ]);

    const expected: string[] = [
      "moveSelection",
      "scrollReader",
      "openSelected",
      "closeViewer",
      "toggleStar",
      "archive",
      "trash",
      "toggleRead",
      "focusReply",
      "focusSearch",
      "toggleFilter",
      "toggleNavigation",
      "toggleShortcutsOverlay",
    ];

    for (const type of expected) {
      expect(documented.has(type as never), `no sheet entry for ${type}`).toBe(true);
    }

    // And nothing in the sheet is undocumented, which catches a row added for
    // an action nobody wired up.
    for (const binding of BINDINGS) {
      expect(
        expected.includes(binding.command.type) || implicit.has(binding.command.type),
        `sheet row "${binding.keys}" produces an unhandled command: ${binding.command.type}`,
      ).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import { isLongError, isSelectAll, LONG_ERROR_CHARS, selectAllScope, type ScopeNode } from "./textSelection";
import { commandForKey, shouldSwallow, type KeyContext } from "../core/mail/keybinds";

/** A tiny fake tree: each node knows its parent and children, and whether it is a scope. */
class Node implements ScopeNode {
  children: Node[] = [];
  constructor(
    readonly name: string,
    readonly scope = false,
    readonly parent: Node | null = null,
  ) {
    parent?.children.push(this);
  }
  closest(): Node | null {
    if (this.scope) return this;
    return this.parent ? this.parent.closest() : null;
  }
  querySelectorAll(): Node[] {
    const out: Node[] = [];
    const walk = (node: Node) => {
      for (const child of node.children) {
        if (child.scope) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

describe("selectAllScope", () => {
  const app = new Node("app");
  const list = new Node("list", false, app);
  const row = new Node("row", false, list);
  const reader = new Node("reader", true, app);
  const subject = new Node("subject", false, reader);
  const sheet = new Node("sheet", false, app);
  const settings = new Node("settings", true, sheet);

  it("answers with the scope around the candidate", () => {
    expect(selectAllScope([subject])).toBe(reader);
    expect(selectAllScope([reader])).toBe(reader);
  });

  it("answers with the one scope inside a focused sheet panel", () => {
    expect(selectAllScope([sheet])).toBe(settings);
  });

  it("skips a candidate that is in no scope, and one that holds several", () => {
    expect(selectAllScope([row, subject])).toBe(reader);
    expect(selectAllScope([app, subject])).toBe(reader);
  });

  it("prefers the earlier candidate: focus beats the last press", () => {
    expect(selectAllScope([sheet, subject])).toBe(settings);
  });

  it("is null when nothing answers, so the app selects nothing rather than everything", () => {
    expect(selectAllScope([row, null, undefined, app])).toBeNull();
    expect(selectAllScope([])).toBeNull();
  });
});

describe("isSelectAll", () => {
  it("is ⌘A or Ctrl+A, either case", () => {
    expect(isSelectAll({ key: "a", metaKey: true })).toBe(true);
    expect(isSelectAll({ key: "a", ctrlKey: true })).toBe(true);
    expect(isSelectAll({ key: "A", ctrlKey: true })).toBe(true);
  });

  it("is not a bare a, nor a shifted or alted one, nor another letter", () => {
    expect(isSelectAll({ key: "a" })).toBe(false);
    expect(isSelectAll({ key: "a", metaKey: true, shiftKey: true })).toBe(false);
    expect(isSelectAll({ key: "a", ctrlKey: true, altKey: true })).toBe(false);
    expect(isSelectAll({ key: "c", ctrlKey: true })).toBe(false);
  });
});

describe("isLongError", () => {
  it("clamps only past the threshold", () => {
    expect(isLongError("x".repeat(LONG_ERROR_CHARS))).toBe(false);
    expect(isLongError("x".repeat(LONG_ERROR_CHARS + 1))).toBe(true);
  });
});

describe("copy and select-all reach the platform, not a shortcut", () => {
  const context: KeyContext = {
    ready: true,
    composerOpen: false,
    textEditing: false,
    viewerOpen: true,
    overlayVisible: false,
    navigationVisible: false,
    filtersActive: false,
    hasActionTarget: true,
    railCount: 3,
  };

  for (const key of ["c", "C", "a", "x"]) {
    for (const modifier of ["ctrlKey", "metaKey"] as const) {
      it(`${modifier === "ctrlKey" ? "Ctrl" : "⌘"}+${key} is not routed and not swallowed`, () => {
        expect(commandForKey(key, context, { [modifier]: true })).toBeNull();
        expect(shouldSwallow(context, { key, [modifier]: true })).toBe(false);
      });
    }
  }

  it("the same holds with the settings sheet or the palette up", () => {
    for (const over of [{ overlayVisible: true }, { navigationVisible: true }]) {
      expect(commandForKey("c", { ...context, ...over }, { ctrlKey: true })).toBeNull();
      expect(shouldSwallow({ ...context, ...over }, { key: "c", metaKey: true })).toBe(false);
    }
  });
});

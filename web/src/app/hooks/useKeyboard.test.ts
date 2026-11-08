// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Snapshot, WinnowStore } from "../../core/store/store";
import { builtinFilter } from "../../core/model/signals";
import { EMPTY_SELECTION } from "../../ui/selection";
import { useKeyboard } from "./useKeyboard";

type Ctx = Parameters<typeof useKeyboard>[0];

/**
 * The handler reads the store and snapshot through refs at keypress time, so the
 * tests hand it stubs: a store of spies and a snapshot carrying only the fields
 * the router consults.
 */
function makeStore() {
  return {
    moveCursor: vi.fn(),
    openCursor: vi.fn(),
    closeReader: vi.fn(),
    setOverlay: vi.fn(),
    moveNavigation: vi.fn(),
    activateNavigation: vi.fn(),
    toggleFilter: vi.fn(),
    clearFilters: vi.fn(),
    undoLast: vi.fn(),
    archiveWithUndo: vi.fn(),
    trashWithUndo: vi.fn(),
    setReadMany: vi.fn(),
    toggleStar: vi.fn(),
  } as unknown as WinnowStore;
}

function makeSnapshot(over: Record<string, unknown> = {}): Snapshot {
  return {
    status: "ready",
    overlay: "none",
    activeFilters: [],
    view: { selected: null, threads: [] },
    cursorIndex: -1,
    all: [],
    mailbox: "inbox",
    undo: null,
    navigationIndex: 0,
    ...over,
  } as unknown as Snapshot;
}

function thread(id: number) {
  return { representative: { id } };
}

function viewer(id: number, code?: string) {
  return { selected: { id, code }, threads: [thread(id)] };
}

function makeCtx(snapshot: Snapshot, store: WinnowStore, over: Partial<Ctx> = {}): Ctx {
  return {
    storeRef: { current: store },
    snapshotRef: { current: snapshot },
    composerRef: { current: null },
    pills: [],
    selectionRef: { current: EMPTY_SELECTION },
    menuRef: { current: null },
    scheduleModalRef: { current: false },
    sidebarOpenRef: { current: false },
    setSidebarOpen: vi.fn(),
    setSelection: vi.fn(),
    openReply: vi.fn(),
    openForward: vi.fn(),
    openCompose: vi.fn(),
    closeComposer: vi.fn(),
    searchRef: { current: null },
    setScrollStep: vi.fn(),
    phoneRef: { current: false },
    dockedRef: { current: false },
    openSnoozeMenuRef: { current: vi.fn() },
    toggleReadRef: { current: vi.fn() },
    copyCodeRef: { current: vi.fn() },
    setLogoView: vi.fn(),
    ...over,
  };
}

function setup(snapshot = makeSnapshot(), store = makeStore(), over: Partial<Ctx> = {}) {
  const ctx = makeCtx(snapshot, store, over);
  renderHook(() => useKeyboard(ctx));
  return { ctx, store };
}

function press(init: KeyboardEventInit, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

afterEach(cleanup);

describe("useKeyboard", () => {
  it("moves the list cursor with j and k", () => {
    const { store } = setup();
    press({ key: "j" });
    press({ key: "k" });
    expect(store.moveCursor).toHaveBeenNthCalledWith(1, 1);
    expect(store.moveCursor).toHaveBeenNthCalledWith(2, -1);
  });

  it("routes nothing before the app is ready", () => {
    const { store } = setup(makeSnapshot({ status: "loading" }));
    const event = press({ key: "j" });
    expect(store.moveCursor).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("opens the cursor's message with Enter", () => {
    const { store } = setup(makeSnapshot({ cursorIndex: 0 }));
    press({ key: "Enter" });
    expect(store.openCursor).toHaveBeenCalledOnce();
  });

  it("archives the open message with e", () => {
    const { store } = setup(makeSnapshot({ view: viewer(42) }));
    press({ key: "e" });
    expect(store.archiveWithUndo).toHaveBeenCalledWith([42]);
  });

  it("acts on the whole selection when rows are selected", () => {
    const setSelection = vi.fn();
    const snapshot = makeSnapshot({
      view: { selected: null, threads: [thread(1), thread(2), thread(3)] },
    });
    const { store } = setup(snapshot, makeStore(), {
      selectionRef: { current: new Set([1, 3]) },
      setSelection,
    });
    press({ key: "e" });
    // Batch actions run in list order, not selection order.
    expect(store.archiveWithUndo).toHaveBeenCalledWith([1, 3]);
    expect(setSelection).toHaveBeenCalledWith(EMPTY_SELECTION);
  });

  it("Escape clears a multi-selection before anything else", () => {
    const setSelection = vi.fn();
    const { store } = setup(makeSnapshot(), makeStore(), {
      selectionRef: { current: new Set([7]) },
      setSelection,
    });
    const event = press({ key: "Escape" });
    expect(event.defaultPrevented).toBe(true);
    expect(setSelection).toHaveBeenCalledWith(EMPTY_SELECTION);
    expect(store.setOverlay).not.toHaveBeenCalled();
  });

  it("a modal composer owns the keyboard; the hook routes nothing", () => {
    // `ready` is false while the sheet is up, so even Escape passes through —
    // the Composer component handles its own dismissal.
    const { store } = setup(makeSnapshot(), makeStore(), { composerRef: { current: {} } });
    const escape = press({ key: "Escape" });
    press({ key: "j" });
    expect(store.moveCursor).not.toHaveBeenCalled();
    expect(escape.defaultPrevented).toBe(false);
  });

  it("a docked composer is not modal: canvas keys work outside it", () => {
    const { store } = setup(makeSnapshot(), makeStore(), {
      composerRef: { current: {} },
      dockedRef: { current: true },
    });
    press({ key: "j" });
    expect(store.moveCursor).toHaveBeenCalledWith(1);
  });

  it("an open menu owns the keyboard", () => {
    const { store } = setup(makeSnapshot(), makeStore(), { menuRef: { current: {} } });
    press({ key: "j" });
    press({ key: "Escape" });
    expect(store.moveCursor).not.toHaveBeenCalled();
  });

  it("the open sidebar is modal: only Escape and [ get through", () => {
    const setSidebarOpen = vi.fn();
    const { store } = setup(makeSnapshot(), makeStore(), {
      sidebarOpenRef: { current: true },
      setSidebarOpen,
    });
    press({ key: "j" });
    expect(store.moveCursor).not.toHaveBeenCalled();

    press({ key: "Escape" });
    expect(setSidebarOpen).toHaveBeenLastCalledWith(false);

    press({ key: "[" });
    expect(setSidebarOpen).toHaveBeenLastCalledWith(false);
  });

  it("a text field keeps its own keys", () => {
    const { store } = setup();
    const input = document.createElement("input");
    document.body.appendChild(input);
    press({ key: "j" }, input);
    expect(store.moveCursor).not.toHaveBeenCalled();
    input.remove();
  });

  it("Enter on a plain button is the button's click, not openSelected", () => {
    const { store } = setup(makeSnapshot({ cursorIndex: 0 }));
    const button = document.createElement("button");
    document.body.appendChild(button);
    const event = press({ key: "Enter" }, button);
    expect(store.openCursor).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    button.remove();
  });

  it("r replies and f forwards the open message", () => {
    const openReply = vi.fn();
    const openForward = vi.fn();
    setup(makeSnapshot({ view: viewer(42) }), makeStore(), { openReply, openForward });
    press({ key: "r" });
    press({ key: "f" });
    expect(openReply).toHaveBeenCalledOnce();
    expect(openForward).toHaveBeenCalledOnce();
  });

  it("c composes when the open message has no code", () => {
    const openCompose = vi.fn();
    setup(makeSnapshot({ view: viewer(42) }), makeStore(), { openCompose });
    press({ key: "c" });
    expect(openCompose).toHaveBeenCalledOnce();
  });

  it("c copies the open message's code when it has one", () => {
    const openCompose = vi.fn();
    const copyCode = vi.fn();
    setup(makeSnapshot({ view: viewer(42, "418902") }), makeStore(), {
      openCompose,
      copyCodeRef: { current: copyCode },
    });
    press({ key: "c" });
    expect(copyCode).toHaveBeenCalledWith(42);
    expect(openCompose).not.toHaveBeenCalled();
  });

  it("/ focuses and selects the search field, swapping the logo back first", () => {
    const setLogoView = vi.fn();
    const input = document.createElement("input");
    document.body.appendChild(input);
    setup(makeSnapshot(), makeStore(), {
      searchRef: { current: input },
      setLogoView,
    });
    press({ key: "/" });
    expect(setLogoView).toHaveBeenCalledOnce();
    const updater = setLogoView.mock.calls[0]![0] as (view: "search" | "version") => string;
    expect(updater("version")).toBe("search");
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it("u marks the open message read or unread through the toggle ref", () => {
    const toggleRead = vi.fn();
    setup(makeSnapshot({ view: viewer(42) }), makeStore(), {
      toggleReadRef: { current: toggleRead },
    });
    press({ key: "u" });
    expect(toggleRead).toHaveBeenCalledWith(42);
  });

  it("b opens the snooze menu for the open message", () => {
    const openSnoozeMenu = vi.fn();
    setup(makeSnapshot({ view: viewer(42) }), makeStore(), {
      openSnoozeMenuRef: { current: openSnoozeMenu },
    });
    press({ key: "b" });
    expect(openSnoozeMenu).toHaveBeenCalledWith([42], null);
  });

  it("z takes the pill's undo offer", () => {
    const { store } = setup(makeSnapshot({ undo: { label: "Archived", at: 1 } }));
    press({ key: "z" });
    expect(store.undoLast).toHaveBeenCalledOnce();
  });

  it("a digit toggles the filter pill in that rail position", () => {
    const { store } = setup(makeSnapshot(), makeStore(), {
      pills: [{ id: builtinFilter("important"), label: "Important", hue: { h: 0, s: 0 }, count: 3 }],
    });
    press({ key: "1" });
    expect(store.toggleFilter).toHaveBeenCalledWith(builtinFilter("important"));
  });

  it("? toggles the shortcuts overlay and , opens settings", () => {
    const { store } = setup();
    press({ key: "?", shiftKey: true });
    expect(store.setOverlay).toHaveBeenLastCalledWith("shortcuts");
    press({ key: "," });
    expect(store.setOverlay).toHaveBeenLastCalledWith("settings");
  });

  it("ArrowDown scrolls the open reader instead of moving the cursor", () => {
    const setScrollStep = vi.fn();
    setup(makeSnapshot({ view: viewer(42) }), makeStore(), { setScrollStep });
    press({ key: "ArrowDown" });
    const step = setScrollStep.mock.calls[0]![0] as (n: number) => number;
    expect(step(4)).toBe(5);
  });
});

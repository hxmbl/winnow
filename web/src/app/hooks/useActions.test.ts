// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { Snapshot, WinnowStore } from "../../core/store/store";
import { EMPTY_SELECTION } from "../../ui/selection";
import { useActions } from "./useActions";

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    getSnapshot: vi.fn(() => ({
      all: [],
      view: { selected: null },
    })),
    openRow: vi.fn(),
    closeReader: vi.fn(),
    moveCursor: vi.fn(),
    setRead: vi.fn(),
    markUnreadAndMoveOn: vi.fn(),
    moveWithUndo: vi.fn(),
    discardDraftWithUndo: vi.fn(),
    toggleStar: vi.fn(),
    ...overrides,
  } as unknown as WinnowStore;
}

function setup(options: {
  store?: WinnowStore;
  mailbox?: Snapshot["mailbox"];
  selectedId?: number;
  rowIds?: number[];
  phone?: boolean;
  selection?: number[];
} = {}) {
  const store = options.store ?? makeStore();
  const storeRef = { current: store };
  const snapshotRef = {
    current: {
      mailbox: options.mailbox ?? "inbox",
      view: {
        selected: options.selectedId === undefined ? null : { id: options.selectedId },
        threads: (options.rowIds ?? []).map((id) => ({ representative: { id } })),
      },
    } as unknown as Snapshot,
  };
  const selectionRef = { current: new Set(options.selection ?? []) };
  const setSelection = vi.fn();
  const setMenu = vi.fn();
  const setPhoneConfirm = vi.fn();
  const hook = renderHook(() =>
    useActions({
      store,
      storeRef,
      snapshotRef,
      mailbox: snapshotRef.current.mailbox,
      phoneRef: { current: options.phone ?? false },
      selectionRef,
      setSelection,
      setMenu,
      setPhoneConfirm,
    }),
  );
  return { ...hook, store, setSelection, setMenu, setPhoneConfirm };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useActions", () => {
  it("opens a clicked row by its current visible index", () => {
    const { result, store } = setup({ rowIds: [10, 20, 30] });

    act(() => result.current.handleSelectRow(20));
    act(() => result.current.handleSelectRow(99));

    expect(store.openRow).toHaveBeenCalledOnce();
    expect(store.openRow).toHaveBeenCalledWith(1);
  });

  it("runs a batch in visible row order and clears the selection", () => {
    const { result, store, setSelection } = setup({ rowIds: [10, 20, 30], selection: [30, 10] });
    const action = vi.fn();

    act(() => result.current.runBatch(action));

    expect(action).toHaveBeenCalledWith(store, [10, 30]);
    expect(setSelection).toHaveBeenCalledWith(EMPTY_SELECTION);
  });

  it("moves on when marking the open message unread and restores focus on phones", () => {
    const store = makeStore({
      getSnapshot: vi.fn(() => ({
        all: [{ id: 42, unread: false }],
        view: { selected: { id: 42 } },
      })),
    });
    const { result } = setup({ store, selectedId: 42, phone: true });
    const row = document.createElement("div");
    const button = document.createElement("button");
    row.setAttribute("data-row-count", "");
    button.setAttribute("data-message-id", "42");
    row.append(button);
    document.body.append(row);
    const focus = vi.spyOn(button, "focus");
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

    act(() => result.current.toggleReadFor(42));

    expect(store.markUnreadAndMoveOn).toHaveBeenCalledWith(42, { phone: true });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    row.remove();
  });
});

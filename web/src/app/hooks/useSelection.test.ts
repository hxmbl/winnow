// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useSelection } from "./useSelection";

type View = Parameters<typeof useSelection>[0];

/**
 * The hook reads only `mailbox` and `view.threads` (for the row order), so the
 * snapshot is a stub of exactly those fields.
 */
function view(mailbox: View["mailbox"], threadIds: readonly number[]): View {
  return {
    mailbox,
    view: { threads: threadIds.map((id) => ({ representative: { id } })) },
  } as unknown as View;
}

function setup(initial: View) {
  return renderHook((props: View) => useSelection(props), { initialProps: initial });
}

function select(result: { current: ReturnType<typeof useSelection> }, ids: readonly number[]) {
  act(() => result.current.setSelection(new Set(ids)));
}

afterEach(cleanup);

describe("useSelection", () => {
  it("starts empty and derives the row order from the visible threads", () => {
    const { result } = setup(view("inbox", [10, 20, 30]));
    expect(result.current.selection.size).toBe(0);
    expect(result.current.rowOrder).toEqual([10, 20, 30]);
    expect(result.current.selectionRef.current).toBe(result.current.selection);
  });

  it("setSelection updates the selection and the ref the keyboard reads", () => {
    const { result } = setup(view("inbox", [10, 20]));
    select(result, [10]);
    expect([...result.current.selection]).toEqual([10]);
    expect(result.current.selectionRef.current).toBe(result.current.selection);
  });

  it("drops selected ids that leave the list", () => {
    const { result, rerender } = setup(view("inbox", [10, 20, 30]));
    select(result, [10, 30]);
    rerender(view("inbox", [10, 20]));
    expect(result.current.rowOrder).toEqual([10, 20]);
    expect([...result.current.selection]).toEqual([10]);
  });

  it("keeps the selection while the same rows stay listed", () => {
    const { result, rerender } = setup(view("inbox", [10, 20]));
    select(result, [20]);
    // A new snapshot object with the same threads must not prune or reset.
    rerender(view("inbox", [10, 20]));
    expect([...result.current.selection]).toEqual([20]);
  });

  it("clears the selection when the mailbox changes", () => {
    const { result, rerender } = setup(view("inbox", [10, 20]));
    select(result, [10, 20]);
    rerender(view("archive", [10, 20]));
    expect(result.current.selection.size).toBe(0);
    // The rows are still listed, so this is the mailbox reset, not a prune.
    expect(result.current.rowOrder).toEqual([10, 20]);
  });
});

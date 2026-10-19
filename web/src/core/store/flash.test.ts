/**
 * The store's flash: a short word about the last action ("Draft saved."), shown in the
 * status pill and gone by itself, and the undo offer's ordering stamp beside it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { WinnowStore } from "./store";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";

const demo = () => new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });

afterEach(() => vi.useRealTimers());

describe("the flash", () => {
  it("shows, then goes by itself after its time", () => {
    vi.useFakeTimers();
    const store = demo();
    store.flash("Draft saved.", 4000);
    expect(store.getSnapshot().flash?.text).toBe("Draft saved.");
    vi.advanceTimersByTime(3999);
    expect(store.getSnapshot().flash).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot().flash).toBeNull();
  });

  it("is replaced by a newer one, which keeps its own time", () => {
    vi.useFakeTimers();
    const store = demo();
    store.flash("Draft saved.", 4000);
    vi.advanceTimersByTime(3000);
    store.flash("Message sent.", 6000);
    vi.advanceTimersByTime(1500);
    expect(store.getSnapshot().flash?.text).toBe("Message sent.");
    vi.advanceTimersByTime(4500);
    expect(store.getSnapshot().flash).toBeNull();
  });

  it("can be dismissed early", () => {
    const store = demo();
    store.flash("Draft saved.", 4000);
    store.dismissFlash();
    expect(store.getSnapshot().flash).toBeNull();
  });

  it("goes with the account on sign-out", async () => {
    const store = demo();
    store.flash("Message sent.", 6000);
    await store.signOut();
    expect(store.getSnapshot().flash).toBeNull();
  });
});

describe("the undo offer's stamp", () => {
  it("is when it was offered, so the pill can put the newest first", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const store = demo();
    const row = store.getSnapshot().view.threads[0].representative;
    store.flash("Draft saved.", 4000);
    vi.setSystemTime(51_000);
    store.moveWithUndo(row.id, "trash");
    const { undo, flash } = store.getSnapshot();
    expect(undo).toEqual({ label: "Moved to Trash.", at: 51_000 });
    expect(flash?.at).toBe(50_000);
  });
});

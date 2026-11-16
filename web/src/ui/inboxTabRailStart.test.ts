/**
 * STRM-452: on a phone, a tap on the dock's Inbox tab also takes the smart-filter rail
 * back to its first pill (`scrollLeft` 0), whatever else the tap does (clear a filter,
 * return the list to its starting edge, or switch to Inbox). Smooth, or a jump under reduced
 * motion. Driven through `tapTab`, the way `PhoneDock` calls it, without a DOM.
 */

import { describe, expect, it, vi } from "vitest";
import { tapTab } from "./phoneDock";
import { scrollRailToStart } from "./listScroll";

function handlers() {
  return {
    onClearFilters: vi.fn(),
    scrollToStart: vi.fn(),
    onSelectMailbox: vi.fn(),
    scrollRailToStart: vi.fn(),
  };
}

describe("the Inbox tab takes the smart-filter rail back to its start (STRM-452)", () => {
  it("with a filter on: clears it and resets the rail", () => {
    const h = handlers();
    expect(tapTab("inbox", { current: true, filtering: true }, h)).toBe("clear-filters");
    expect(h.onClearFilters).toHaveBeenCalledTimes(1);
    expect(h.scrollRailToStart).toHaveBeenCalledTimes(1);
  });

  it("with no filter: returns the list to its start and resets the rail", () => {
    const h = handlers();
    expect(tapTab("inbox", { current: true, filtering: false }, h)).toBe("scroll-start");
    expect(h.scrollToStart).toHaveBeenCalledTimes(1);
    expect(h.scrollRailToStart).toHaveBeenCalledTimes(1);
  });

  it("from another mailbox: switches to Inbox and resets the rail", () => {
    const h = handlers();
    expect(tapTab("inbox", { current: false, filtering: false }, h)).toBe("select");
    expect(h.onSelectMailbox).toHaveBeenCalledWith("inbox");
    expect(h.scrollRailToStart).toHaveBeenCalledTimes(1);
  });

  it("the Sent tab leaves the rail where it is", () => {
    const h = handlers();
    tapTab("sent", { current: true, filtering: false }, h);
    tapTab("sent", { current: false, filtering: false }, h);
    expect(h.scrollRailToStart).not.toHaveBeenCalled();
  });

  it("still works when the dock passes no rail handler", () => {
    const scrollToStart = vi.fn();
    const plain = { onClearFilters: vi.fn(), scrollToStart, onSelectMailbox: vi.fn() };
    expect(tapTab("inbox", { current: true, filtering: false }, plain)).toBe("scroll-start");
    expect(scrollToStart).toHaveBeenCalledTimes(1);
  });
});

describe("scrollRailToStart", () => {
  it("scrolls smoothly to the first pill", () => {
    const scroller = { scrollTo: vi.fn() };
    scrollRailToStart(scroller, false);
    expect(scroller.scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "smooth" });
  });

  it("jumps there instantly under reduced motion", () => {
    const scroller = { scrollTo: vi.fn() };
    scrollRailToStart(scroller, true);
    expect(scroller.scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "auto" });
  });

  it("does nothing without a rail", () => {
    expect(() => scrollRailToStart(null, false)).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { DOCK_TABS, EXPAND_LABEL, badgeText, PANEL_ORDER, panelOrder, tabAction, tabLabel } from "./phoneDock";

describe("the phone dock", () => {
  it("has two tabs, Inbox then Sent; Archive and the rest are behind Expand", () => {
    expect(DOCK_TABS).toEqual(["inbox", "sent"]);
    expect(EXPAND_LABEL).toBe("More mailboxes");
  });

  it("switches mailbox on a tap, and scrolls to the top on a tap of the current tab", () => {
    expect(tabAction(false)).toBe("select");
    expect(tabAction(true)).toBe("scroll-top");
  });

  it("never opens the menu from a tab", () => {
    expect(["select", "scroll-top"]).toContain(tabAction(true));
    expect(["select", "scroll-top"]).toContain(tabAction(false));
  });

  it("names a tab by its mailbox, with the unread count when there is one", () => {
    expect(tabLabel("Inbox", 6)).toBe("Inbox, 6 unread");
    expect(tabLabel("Inbox", 0)).toBe("Inbox");
    expect(tabLabel("Sent", 0)).toBe("Sent");
  });

  it("badges unread counts, capped at 99+", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(7)).toBe("7");
    expect(badgeText(120)).toBe("99+");
  });

  it("lists the panel's folders rarest first, Archive then Sent nearest the thumb", () => {
    const folders = [{ id: "archive" }, { id: "sent" }, { id: "drafts" }, { id: "trash" }, { id: "spam" }] as const;
    expect(panelOrder(folders).map((f) => f.id)).toEqual(["spam", "trash", "drafts", "archive", "sent"]);
    expect([...PANEL_ORDER]).toEqual(["spam", "trash", "drafts", "archive", "sent"]);
    // Whatever order the caller hands in, the named folders land in the panel's order.
    const shuffled = [{ id: "sent" }, { id: "spam" }, { id: "archive" }, { id: "trash" }, { id: "drafts" }] as const;
    expect(panelOrder(shuffled).map((f) => f.id)).toEqual(["spam", "trash", "drafts", "archive", "sent"]);
    // A copy: the caller's order is left alone.
    expect(folders[0].id).toBe("archive");
  });
});

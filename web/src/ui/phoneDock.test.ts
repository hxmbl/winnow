import { describe, expect, it } from "vitest";
import { inboxTabAction, inboxTabLabel } from "./phoneDock";

describe("the Inbox tab", () => {
  it("switches to the inbox on the first tap", () => {
    expect(inboxTabAction(false, false)).toBe("select");
  });

  it("opens the menu on a tap while it is the current tab", () => {
    expect(inboxTabAction(true, false)).toBe("open-menu");
  });

  it("closes the menu on the next tap, current or not", () => {
    expect(inboxTabAction(true, true)).toBe("close-menu");
    expect(inboxTabAction(false, true)).toBe("close-menu");
  });

  it("is plainly Inbox until a second activation would open the menu", () => {
    expect(inboxTabLabel(6, false, false)).toBe("Inbox, 6 unread");
    expect(inboxTabLabel(0, false, false)).toBe("Inbox");
  });

  it("says a second activation opens the menu, and then that it closes it", () => {
    expect(inboxTabLabel(6, true, false)).toBe("Inbox, 6 unread. Activate again for mailboxes and account");
    expect(inboxTabLabel(0, true, true)).toBe("Inbox. Activate again to close mailboxes and account");
  });
});

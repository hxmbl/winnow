import { describe, expect, it } from "vitest";
import { BACKGROUND_SYNC_NOTE, backgroundSyncOffer } from "./backgroundSyncSetting";

describe("backgroundSyncOffer", () => {
  it("the desktop app gets the switch and its interval", () => {
    expect(backgroundSyncOffer({ isNative: true, available: true, android: false })).toBe("switch");
  });

  it("the Android app gets the switch too, which starts and stops the background service", () => {
    expect(backgroundSyncOffer({ isNative: true, available: true, android: true })).toBe("service");
  });

  it("a browser tab, or a platform that has not answered, gets the web note", () => {
    expect(backgroundSyncOffer({ isNative: false, available: null, android: false })).toBe("web-note");
    expect(backgroundSyncOffer({ isNative: false, available: true, android: false })).toBe("web-note");
    expect(backgroundSyncOffer({ isNative: true, available: null, android: true })).toBe("web-note");
    expect(BACKGROUND_SYNC_NOTE["web-note"]).toMatch(/tab is open/);
  });
});

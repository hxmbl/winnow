import { describe, expect, it } from "vitest";
import { BACKGROUND_SYNC_NOTE, backgroundSyncOffer } from "./backgroundSyncSetting";

describe("backgroundSyncOffer", () => {
  it("offers the switch only where the build can sync with the window closed", () => {
    expect(backgroundSyncOffer({ isNative: true, available: true })).toBe("switch");
  });

  it("the Android app (native, no background sync) gets a note, not a switch that can't move", () => {
    expect(backgroundSyncOffer({ isNative: true, available: false })).toBe("native-note");
    expect(BACKGROUND_SYNC_NOTE["native-note"]).toMatch(/Android/);
  });

  it("a browser tab, or a platform that has not answered, gets the web note", () => {
    expect(backgroundSyncOffer({ isNative: false, available: null })).toBe("web-note");
    expect(backgroundSyncOffer({ isNative: false, available: true })).toBe("web-note");
    expect(backgroundSyncOffer({ isNative: true, available: null })).toBe("web-note");
  });
});

import { describe, expect, it } from "vitest";
import { LOW_BATTERY, downloadBlock } from "./downloadConditions";

const base = { online: true, hidden: false, phone: false };

describe("downloadBlock", () => {
  it("waits offline, hidden on a phone, on a metered link, and on a low battery", () => {
    expect(downloadBlock(base)).toBeNull();
    expect(downloadBlock({ ...base, online: false })).toBe("offline");
    expect(downloadBlock({ ...base, hidden: true, phone: true })).toBe("hidden");
    expect(downloadBlock({ ...base, saveData: true })).toBe("metered");
    expect(downloadBlock({ ...base, connectionType: "cellular" })).toBe("metered");
    expect(downloadBlock({ ...base, battery: { level: LOW_BATTERY - 0.01, charging: false } })).toBe("battery");
  });

  it("keeps going on a hidden desktop window, on Wi-Fi, and on a low battery that is charging", () => {
    expect(downloadBlock({ ...base, hidden: true })).toBeNull();
    expect(downloadBlock({ ...base, connectionType: "wifi" })).toBeNull();
    expect(downloadBlock({ ...base, battery: { level: 0.05, charging: true } })).toBeNull();
  });
});

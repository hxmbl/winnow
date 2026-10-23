import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { UpdateOffer } from "../core/updates/updates";
import { devCheckView } from "./devCheckNow";

const OFFER = { version: "1.6.0", current: "1.5.5", pageUrl: "https://github.com/hxmbl/winnow/releases/tag/v1.6.0", action: { kind: "page" } } as UpdateOffer;

describe("Dev Options → Check now", () => {
  it("says nothing until it is pressed, even when an earlier check found something", () => {
    expect(devCheckView(false, "current", OFFER, null)).toEqual({ state: "idle", line: null });
  });

  it("shows Checking…, then the result inline", () => {
    expect(devCheckView(true, "checking", null, null)).toEqual({ state: "checking", line: "Checking…" });
    expect(devCheckView(true, "idle", OFFER, null)).toEqual({ state: "offer", line: "Update available: 1.6.0 (you have 1.5.5)" });
    expect(devCheckView(true, "current", null, null)).toEqual({ state: "current", line: "No updates available" });
  });

  it("a failed check says Couldn't check, with the reason when there is one, even beside an earlier offer", () => {
    expect(devCheckView(true, "failed", OFFER, "Couldn't check for updates: GitHub answered 503.")).toEqual({
      state: "failed",
      line: "Couldn't check: GitHub answered 503",
    });
    expect(devCheckView(true, "failed", null, null)).toEqual({ state: "failed", line: "Couldn't check" });
  });

  it("the row only checks: it never installs", () => {
    const panel = readFileSync(new URL("components/SettingsPanel.tsx", import.meta.url), "utf8");
    const start = panel.indexOf("function DevCheckNowRow");
    const row = panel.slice(start, panel.indexOf("\n}\n", start));
    expect(row).toContain("updates.checkNow()");
    expect(row).not.toMatch(/updates\.install\b|installUpdate/);
  });
});

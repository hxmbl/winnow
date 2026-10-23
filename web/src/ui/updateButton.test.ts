import { describe, expect, it } from "vitest";
import {
  UPDATE_BUTTON_LABEL,
  noticeAfterCheck,
  updateButtonPress,
  updateButtonShown,
  updateButtonView,
} from "./updateButton";
import type { UpdateChannel } from "../core/updates/updates";

const runtime = (channel: UpdateChannel) => ({ channel, version: "1.5.4", arch: "aarch64" });

describe("the update button beside the version shortcut", () => {
  it("shows on every native build and never on the web build or the Docker image", () => {
    for (const channel of ["macos", "appimage", "deb", "android", "manual"] as const) expect(updateButtonShown(runtime(channel))).toBe(true);
    expect(updateButtonShown(runtime("web"))).toBe(false);
    expect(updateButtonShown(runtime("docker"))).toBe(false);
    expect(updateButtonShown(null)).toBe(false);
  });

  it("walks Check for updates → Checking… → No updates available → Check for updates", () => {
    expect(updateButtonView("idle", false, null)).toBe("check");
    expect(updateButtonView("checking", false, null)).toBe("checking");
    const notice = noticeAfterCheck("current", false);
    expect(notice).toBe("none");
    expect(updateButtonView("current", false, notice)).toBe("none");
    // NOTICE_MS later the notice clears.
    expect(updateButtonView("current", false, null)).toBe("check");
    expect(UPDATE_BUTTON_LABEL.check).toBe("Check for updates");
    expect(UPDATE_BUTTON_LABEL.checking).toBe("Checking…");
    expect(UPDATE_BUTTON_LABEL.none).toBe("No updates available");
  });

  it("→ Update when a newer release is found, → Updating… while it installs", () => {
    expect(noticeAfterCheck("idle", true)).toBeNull();
    expect(updateButtonView("idle", true, null)).toBe("update");
    expect(UPDATE_BUTTON_LABEL.update).toBe("Update");
    expect(updateButtonView("installing", true, null)).toBe("updating");
  });

  it("a failed check says so for a moment, then offers the check again", () => {
    expect(noticeAfterCheck("failed", false)).toBe("failed");
    expect(updateButtonView("failed", false, "failed")).toBe("failed");
    expect(updateButtonView("failed", false, null)).toBe("check");
  });

  it("a press checks, installs, or does nothing while busy", () => {
    expect(updateButtonPress("check")).toBe("check");
    expect(updateButtonPress("none")).toBe("check");
    expect(updateButtonPress("failed")).toBe("check");
    expect(updateButtonPress("update")).toBe("install");
    expect(updateButtonPress("checking")).toBeNull();
    expect(updateButtonPress("updating")).toBeNull();
  });

  it("no notice while a check is still running", () => {
    expect(noticeAfterCheck("checking", false)).toBeNull();
    expect(noticeAfterCheck("installing", false)).toBeNull();
  });
});

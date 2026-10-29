import { describe, expect, it } from "vitest";
import {
  IDLE,
  advance,
  busy,
  failureReason,
  failureText,
  installTarget,
  installing,
  megabytes,
  parseProgress,
  percent,
  stageAnnouncement,
  stageButtonLabel,
  stageText,
  type StageEvent,
  type UpdateStage,
} from "./stages";

const run = (events: StageEvent[], from: UpdateStage = IDLE): UpdateStage => events.reduce(advance, from);

const MB = 1024 * 1024;

describe("the update's stages", () => {
  it("walks checking → downloading → verifying → installing → done", () => {
    let stage = advance(IDLE, { type: "check" });
    expect(stage).toEqual({ stage: "checking" });
    stage = advance(stage, { type: "checked" });
    expect(stage).toEqual(IDLE);

    stage = advance(stage, { type: "install", target: "apk" });
    expect(stage).toEqual({ stage: "downloading", target: "apk", received: 0, total: null });
    stage = advance(stage, { type: "progress", progress: { stage: "downloading", received: 10 * MB, total: 40 * MB } });
    expect(stage).toEqual({ stage: "downloading", target: "apk", received: 10 * MB, total: 40 * MB });
    stage = advance(stage, { type: "progress", progress: { stage: "verifying" } });
    expect(stage).toEqual({ stage: "verifying", target: "apk" });
    stage = advance(stage, { type: "progress", progress: { stage: "installing" } });
    expect(stage).toEqual({ stage: "installing", target: "apk" });
    stage = advance(stage, { type: "finished", outcome: "opened" });
    expect(stage).toEqual({ stage: "done", target: "apk", outcome: "opened" });
    expect(advance(stage, { type: "reset" })).toEqual(IDLE);
  });

  it("only moves forward: a late download tick or a repeat changes nothing", () => {
    const verifying = run([
      { type: "install", target: "deb" },
      { type: "progress", progress: { stage: "downloading", received: 5, total: 10 } },
      { type: "progress", progress: { stage: "verifying" } },
    ]);
    expect(advance(verifying, { type: "progress", progress: { stage: "downloading", received: 10, total: 10 } })).toBe(verifying);
    expect(advance(verifying, { type: "progress", progress: { stage: "verifying" } })).toBe(verifying);

    // A download never counts backwards, nor past its size, and keeps a size once given.
    const halfway = run([
      { type: "install", target: "self" },
      { type: "progress", progress: { stage: "downloading", received: 50, total: 100 } },
    ]);
    expect(advance(halfway, { type: "progress", progress: { stage: "downloading", received: 20, total: 100 } })).toBe(halfway);
    expect(advance(halfway, { type: "progress", progress: { stage: "downloading", received: 500, total: 100 } })).toEqual({
      stage: "downloading",
      target: "self",
      received: 100,
      total: 100,
    });
    expect(advance(halfway, { type: "progress", progress: { stage: "downloading", received: 60, total: null } })).toEqual({
      stage: "downloading",
      target: "self",
      received: 60,
      total: 100,
    });
    // A stage may be skipped (a host that reports no verifying step).
    expect(advance(halfway, { type: "progress", progress: { stage: "installing" } })).toEqual({ stage: "installing", target: "self" });
  });

  it("ignores reports once the install has ended, and outside one", () => {
    const done = run([{ type: "install", target: "apk" }, { type: "finished", outcome: "opened" }]);
    expect(advance(done, { type: "progress", progress: { stage: "installing" } })).toBe(done);
    expect(advance(done, { type: "failed", detail: "late" })).toBe(done);
    expect(advance(IDLE, { type: "progress", progress: { stage: "verifying" } })).toBe(IDLE);
    expect(advance(IDLE, { type: "finished", outcome: "restarting" })).toBe(IDLE);
    expect(advance(IDLE, { type: "failed", detail: "x" })).toBe(IDLE);
  });

  it("never lets a check or a second press interrupt an install", () => {
    const downloading = run([{ type: "install", target: "deb" }]);
    expect(advance(downloading, { type: "check" })).toBe(downloading);
    expect(advance(downloading, { type: "install", target: "apk" })).toBe(downloading);
    expect(advance(downloading, { type: "reset" })).toBe(downloading);
    // After a failure, Update again starts over.
    const failed = advance(downloading, { type: "failed", detail: "the download failed: HTTP 503" });
    expect(advance(failed, { type: "install", target: "deb" })).toEqual({ stage: "downloading", target: "deb", received: 0, total: null });
    expect(advance(failed, { type: "check" })).toEqual({ stage: "checking" });
  });

  it("knows when something is under way", () => {
    expect(installing(IDLE)).toBe(false);
    expect(busy({ stage: "checking" })).toBe(true);
    expect(installing({ stage: "checking" })).toBe(false);
    for (const stage of [
      { stage: "downloading", target: "apk", received: 0, total: null },
      { stage: "verifying", target: "apk" },
      { stage: "installing", target: "apk" },
    ] as UpdateStage[]) {
      expect(installing(stage)).toBe(true);
      expect(busy(stage)).toBe(true);
    }
    expect(busy({ stage: "done", target: "self", outcome: "restarting" })).toBe(false);
    expect(busy({ stage: "failed", reason: "network", detail: "x" })).toBe(false);
  });

  it("maps each offer to how it installs", () => {
    const asset = { name: "a", url: "u", size: 1 };
    expect(installTarget({ kind: "self" })).toBe("self");
    expect(installTarget({ kind: "deb", asset })).toBe("deb");
    expect(installTarget({ kind: "apk", asset })).toBe("apk");
    expect(installTarget({ kind: "page" })).toBeNull();
    expect(installTarget({ kind: "git-pull" })).toBeNull();
    expect(installTarget({ kind: "docker", mode: "auto" })).toBeNull();
  });
});

describe("failure reasons", () => {
  // The hosts' own words: updater.rs, UpdatePlugin.kt and Tauri's updater.
  it.each([
    ["the download doesn't match the release's checksum, so it wasn't installed", "checksum-mismatch"],
    ["couldn't check the download: this release has no checksums (HTTP 404)", "no-checksum"],
    ["couldn't check the download: the release lists no checksum for Winnow_1.7.0_amd64.deb", "no-checksum"],
    ["the signature verification failed", "signature"],
    ["Signature: InvalidSignature", "signature"],
    ["the download failed: HTTP 503", "network"],
    ["the download failed: error sending request for url (https://github.com/...)", "network"],
    ["the download failed: the file is too large", "too-large"],
    ["that release is a pre-release; it is offered only with Beta updates on (Dev Options)", "prerelease"],
    ["could not save the download: No space left on device", "installer"],
    ["the package installer could not be opened: no activity", "installer"],
    ["this copy of Winnow is not one the updater can replace", "other"],
  ] as const)("%s → %s", (detail, reason) => {
    expect(failureReason(detail)).toBe(reason);
  });

  it("words each plainly, keeping the host's words where they say more", () => {
    expect(failureText("checksum-mismatch", "x")).toBe("the download didn't match the release's checksum, so it wasn't installed.");
    expect(failureText("no-checksum", "x")).toMatch(/no checksum/);
    expect(failureText("network", "x")).toMatch(/connection/);
    expect(failureText("installer", "could not save the download: disk full.")).toBe(
      "the download was checked but couldn't be opened (could not save the download: disk full).",
    );
    expect(failureText("other", "this copy of Winnow is not one the updater can replace")).toBe(
      "this copy of Winnow is not one the updater can replace.",
    );
  });

  it("keeps the reason and the host's words on the failed stage", () => {
    const failed = run([
      { type: "install", target: "apk" },
      { type: "progress", progress: { stage: "verifying" } },
      { type: "failed", detail: "the download doesn't match the release's checksum, so it wasn't installed" },
    ]);
    expect(failed).toEqual({
      stage: "failed",
      reason: "checksum-mismatch",
      detail: "the download doesn't match the release's checksum, so it wasn't installed",
    });
    expect(stageText(failed, "1.7.0")).toBe("Couldn't update: the download didn't match the release's checksum, so it wasn't installed.");
    const blank = run([{ type: "install", target: "deb" }, { type: "failed", detail: "  " }]);
    expect(blank).toMatchObject({ stage: "failed", detail: "the update could not be installed" });
  });
});

describe("the words for each stage", () => {
  const downloading = (received: number, total: number | null): UpdateStage => ({ stage: "downloading", target: "apk", received, total });

  it("says what the update is doing", () => {
    expect(stageText(IDLE, "1.7.0")).toBeNull();
    expect(stageText({ stage: "checking" }, "1.7.0")).toBe("Checking for updates…");
    expect(stageText(downloading(0, null), "1.7.0")).toBe("Downloading Winnow 1.7.0…");
    expect(stageText(downloading(21 * MB, 50 * MB), "1.7.0")).toBe("Downloading Winnow 1.7.0… 42%");
    expect(stageText(downloading(3.3 * MB, null), "1.7.0")).toBe("Downloading Winnow 1.7.0… 3.3 MB");
    expect(stageText({ stage: "verifying", target: "deb" }, "1.7.0")).toBe("Verifying the download…");
    expect(stageText({ stage: "installing", target: "self" }, "1.7.0")).toBe("Installing Winnow 1.7.0…");
    expect(stageText({ stage: "installing", target: "deb" }, "1.7.0")).toBe("Opening the installer…");
    expect(stageText({ stage: "installing", target: "apk" }, "1.7.0")).toBe("Opening Android's installer…");
  });

  it("says how the install ended", () => {
    expect(stageText({ stage: "done", target: "self", outcome: "restarting" }, "1.7.0")).toBe("Restarting into Winnow 1.7.0…");
    expect(stageText({ stage: "done", target: "apk", outcome: "opened" }, "1.7.0")).toBe(
      "Android's installer is open. Confirm there to update.",
    );
    expect(stageText({ stage: "done", target: "deb", outcome: "opened", path: "/home/a/Downloads/W.deb" }, "1.7.0")).toBe(
      "Saved to /home/a/Downloads/W.deb. If no installer opened, run: sudo apt install /home/a/Downloads/W.deb",
    );
    expect(stageText({ stage: "done", target: "apk", outcome: "needs-permission" }, "1.7.0")).toMatch(/press Update again/);
    expect(stageText({ stage: "done", target: "self", outcome: "none" }, "1.7.0")).toMatch(/release page/);
  });

  it("has short labels for the button", () => {
    expect(stageButtonLabel(downloading(0, null))).toBe("Downloading…");
    expect(stageButtonLabel(downloading(1, 4))).toBe("Downloading 25%");
    expect(stageButtonLabel({ stage: "verifying", target: "apk" })).toBe("Verifying…");
    expect(stageButtonLabel({ stage: "installing", target: "self" })).toBe("Installing…");
    expect(stageButtonLabel({ stage: "installing", target: "apk" })).toBe("Opening installer…");
    expect(stageButtonLabel(IDLE)).toBeNull();
    expect(stageButtonLabel({ stage: "checking" })).toBeNull();
  });

  it("announces a download once, not at every percent", () => {
    expect(stageAnnouncement(downloading(1, 4), "1.7.0")).toBe("Downloading Winnow 1.7.0.");
    expect(stageAnnouncement(downloading(3, 4), "1.7.0")).toBe("Downloading Winnow 1.7.0.");
    expect(stageAnnouncement({ stage: "verifying", target: "apk" }, "1.7.0")).toBe("Verifying the download…");
    expect(stageAnnouncement(IDLE, "1.7.0")).toBe("");
  });

  it("rounds percentages down and sizes sensibly", () => {
    expect(percent(0, 100)).toBe(0);
    expect(percent(999, 1000)).toBe(99);
    expect(percent(1000, 1000)).toBe(100);
    expect(percent(2000, 1000)).toBe(100);
    expect(percent(5, null)).toBeNull();
    expect(percent(5, 0)).toBeNull();
    expect(megabytes(0.5 * MB)).toBe("0.5 MB");
    expect(megabytes(42.4 * MB)).toBe("42 MB");
  });
});

describe("reading a host's progress report", () => {
  it("reads what Rust and the Kotlin plugin send", () => {
    expect(parseProgress({ stage: "downloading", received: 10, total: 100 })).toEqual({ stage: "downloading", received: 10, total: 100 });
    // Rust sends `total: null` without a size; Kotlin leaves it out.
    expect(parseProgress({ stage: "downloading", received: 10, total: null })).toEqual({ stage: "downloading", received: 10, total: null });
    expect(parseProgress({ stage: "downloading", received: 10 })).toEqual({ stage: "downloading", received: 10, total: null });
    expect(parseProgress({ stage: "verifying" })).toEqual({ stage: "verifying" });
    expect(parseProgress({ stage: "installing" })).toEqual({ stage: "installing" });
  });

  it("refuses anything else, and cleans up odd sizes", () => {
    expect(parseProgress(null)).toBeNull();
    expect(parseProgress("downloading")).toBeNull();
    expect(parseProgress({ stage: "exploding" })).toBeNull();
    expect(parseProgress({ stage: "downloading", received: -5, total: 0 })).toEqual({ stage: "downloading", received: 0, total: null });
    expect(parseProgress({ stage: "downloading", received: "10", total: Number.NaN })).toEqual({
      stage: "downloading",
      received: 0,
      total: null,
    });
    expect(parseProgress({ stage: "downloading", received: 10.7, total: 20.2 })).toEqual({ stage: "downloading", received: 10, total: 20 });
  });
});

import { describe, expect, it } from "vitest";
import {
  CHECK_INTERVAL_MS,
  DEFAULT_UPDATE_STATE,
  RETRY_AFTER_FAILURE_MS,
  aptCommand,
  checkDue,
  checkForUpdate,
  compareVersions,
  dismiss,
  isNewer,
  isReleaseDownload,
  msUntilDue,
  DOCKER_PULL_COMMAND,
  DOCKER_RESTART_COMMAND,
  GIT_PULL_COMMAND,
  offerButton,
  offerText,
  operatorUpdate,
  parseChannel,
  parseRelease,
  parseUpdateState,
  parseVersion,
  pickAsset,
  planUpdate,
  recordCheck,
  serialiseUpdateState,
  shouldAnnounce,
  type Release,
  type UpdateChannel,
  type UpdateRuntime,
} from "./updates";

const DL = "https://github.com/hxmbl/winnow/releases/download/v1.5.0/";

function githubRelease(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v1.5.0",
    html_url: "https://github.com/hxmbl/winnow/releases/tag/v1.5.0",
    draft: false,
    prerelease: false,
    assets: [
      "Winnow_1.5.0_amd64.AppImage",
      "Winnow_1.5.0_amd64.AppImage.sig",
      "Winnow_1.5.0_amd64.deb",
      "Winnow_1.5.0_universal.dmg",
      "Winnow_1.5.0_universal.app.tar.gz",
      "Winnow_1.5.0_universal.app.tar.gz.sig",
      "Winnow_1.5.0_android-universal.apk",
      "latest.json",
    ].map((name, i) => ({ name, browser_download_url: DL + name, size: 1000 + i })),
    ...overrides,
  };
}

const release = parseRelease(githubRelease()) as Release;

const runtime = (channel: UpdateChannel, version = "1.4.0", arch = "x86_64"): UpdateRuntime => ({
  channel,
  version,
  arch,
});

describe("versions", () => {
  it("parses releases, tags and pre-releases", () => {
    expect(parseVersion("1.4.0")).toEqual({ major: 1, minor: 4, patch: 0, pre: [] });
    expect(parseVersion("v1.5.0-beta.2")).toEqual({ major: 1, minor: 5, patch: 0, pre: ["beta", "2"] });
    expect(parseVersion("1.5.0+build.7")).toEqual({ major: 1, minor: 5, patch: 0, pre: [] });
    for (const bad of ["", "1.4", "1.4.0.1", "latest", "v", null, undefined, "1.4.x"]) {
      expect(parseVersion(bad as string)).toBeNull();
    }
  });

  it("orders by semver, numerically, with a release above its pre-releases", () => {
    const order = [
      "1.3.9",
      "1.4.0-alpha",
      "1.4.0-alpha.1",
      "1.4.0-alpha.beta",
      "1.4.0-beta",
      "1.4.0-beta.2",
      "1.4.0-beta.11",
      "1.4.0-rc.1",
      "1.4.0",
      "1.4.1",
      "1.10.0",
      "2.0.0",
    ];
    for (let i = 0; i < order.length - 1; i += 1) {
      const a = parseVersion(order[i])!;
      const b = parseVersion(order[i + 1])!;
      expect(compareVersions(a, b), `${order[i]} < ${order[i + 1]}`).toBeLessThan(0);
      expect(compareVersions(b, a)).toBeGreaterThan(0);
    }
    expect(compareVersions(parseVersion("v1.4.0")!, parseVersion("1.4.0")!)).toBe(0);
  });

  it("is newer only when strictly newer and both readable", () => {
    expect(isNewer("1.5.0", "1.4.0")).toBe(true);
    expect(isNewer("1.4.0", "1.4.0")).toBe(false);
    expect(isNewer("1.3.5", "1.4.0")).toBe(false);
    expect(isNewer("1.4.0", "1.4.0-beta.3")).toBe(true);
    expect(isNewer("1.10.0", "1.9.9")).toBe(true);
    expect(isNewer("garbage", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "0.0.0-dev")).toBe(true);
  });
});

describe("releases", () => {
  it("reads GitHub's release JSON", () => {
    expect(release.version).toBe("1.5.0");
    expect(release.tag).toBe("v1.5.0");
    expect(release.pageUrl).toBe("https://github.com/hxmbl/winnow/releases/tag/v1.5.0");
    expect(release.assets).toHaveLength(8);
  });

  it("refuses drafts, pre-releases, non-version tags and junk", () => {
    expect(parseRelease(githubRelease({ draft: true }))).toBeNull();
    expect(parseRelease(githubRelease({ prerelease: true }))).toBeNull();
    expect(parseRelease(githubRelease({ tag_name: "nightly" }))).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease("v1.5.0")).toBeNull();
  });

  it("drops assets that are not this repository's release downloads", () => {
    const parsed = parseRelease(
      githubRelease({
        assets: [
          { name: "Winnow_1.5.0_amd64.deb", browser_download_url: "https://evil.example/Winnow_1.5.0_amd64.deb" },
          { name: "x.apk", browser_download_url: "https://github.com/someone/else/releases/download/v1/x.apk" },
          { name: "ok.deb", browser_download_url: `${DL}ok.deb` },
          "not an object",
        ],
        html_url: "https://evil.example/",
      }),
    )!;
    expect(parsed.assets.map((asset) => asset.name)).toEqual(["ok.deb"]);
    expect(parsed.pageUrl).toBe("https://github.com/hxmbl/winnow/releases/latest");
  });

  it("checks download URLs strictly", () => {
    expect(isReleaseDownload(`${DL}Winnow_1.5.0_amd64.deb`)).toBe(true);
    expect(isReleaseDownload("http://github.com/hxmbl/winnow/releases/download/v1/x.deb")).toBe(false);
    expect(isReleaseDownload("https://github.com/hxmbl/winnow/releases/download/../../x")).toBe(false);
    expect(isReleaseDownload("https://github.com.evil.example/hxmbl/winnow/releases/download/v1/x")).toBe(false);
  });
});

describe("asset picking", () => {
  it("picks the amd64 .deb on x86_64, and nothing for an arch the release lacks", () => {
    expect(pickAsset("deb", "x86_64", release.assets)?.name).toBe("Winnow_1.5.0_amd64.deb");
    expect(pickAsset("deb", "aarch64", release.assets)).toBeNull();
  });

  it("picks the signed universal APK and never a debug one", () => {
    expect(pickAsset("android", "aarch64", release.assets)?.name).toBe("Winnow_1.5.0_android-universal.apk");
    const debugOnly = release.assets
      .filter((asset) => !asset.name.endsWith(".apk"))
      .concat([{ name: "Winnow_1.5.0_android-universal-debug.apk", url: `${DL}d.apk`, size: 1 }]);
    expect(pickAsset("android", "aarch64", debugOnly)).toBeNull();
  });

  it("picks nothing for channels that install without one", () => {
    for (const channel of ["macos", "appimage", "web", "manual"] as const) {
      expect(pickAsset(channel, "x86_64", release.assets)).toBeNull();
    }
  });
});

describe("routing by runtime", () => {
  it("self-updates the macOS app and the AppImage", () => {
    expect(planUpdate(runtime("macos", "1.4.0", "aarch64"), release)?.action).toEqual({ kind: "self" });
    expect(planUpdate(runtime("appimage"), release)?.action).toEqual({ kind: "self" });
  });

  it("downloads the .deb for a package install and the APK on Android", () => {
    const deb = planUpdate(runtime("deb"), release)!;
    expect(deb.action.kind).toBe("deb");
    expect(deb.action.kind === "deb" && aptCommand(deb.action.asset)).toBe("sudo apt install ./Winnow_1.5.0_amd64.deb");
    const apk = planUpdate(runtime("android", "1.4.0", "aarch64"), release)!;
    expect(apk.action.kind === "apk" && apk.action.asset.name).toBe("Winnow_1.5.0_android-universal.apk");
  });

  it("tells a self-hosted web build to git pull, with no button", () => {
    const offer = planUpdate(runtime("web"), release)!;
    expect(offer.action).toEqual({ kind: "git-pull" });
    expect(offerText(offer)).toMatch(/git pull/);
    expect(offerButton(offer)).toBeNull();
  });

  it("tells a Docker deployment to restart the container, with no button", () => {
    const offer = planUpdate(runtime("docker"), release)!;
    expect(offer.action).toEqual({ kind: "docker", mode: "auto" });
    expect(offerText(offer)).toBe("Winnow 1.5.0 is out. Restart the container to update.");
    expect(offerButton(offer)).toBeNull();
    expect(operatorUpdate(offer)?.command).toBe(DOCKER_RESTART_COMMAND);
    expect(DOCKER_RESTART_COMMAND).toBe("docker compose restart");
  });

  it("tells a pinned or non-updating Docker deployment what to change first", () => {
    const pinned = planUpdate({ ...runtime("docker"), docker: "pinned" }, release)!;
    expect(pinned.action).toEqual({ kind: "docker", mode: "pinned" });
    expect(operatorUpdate(pinned)?.before).toMatch(/WINNOW_VERSION to v1\.5\.0/);
    expect(offerText(pinned)).not.toMatch(/Restart/);
    const image = planUpdate({ ...runtime("docker"), docker: "image" }, release)!;
    expect(operatorUpdate(image)?.command).toBe(DOCKER_PULL_COMMAND);
    expect(offerButton(image)).toBeNull();
  });

  it("gives the operator's command only where there is no button", () => {
    expect(operatorUpdate(planUpdate(runtime("web"), release)!)?.command).toBe(GIT_PULL_COMMAND);
    for (const channel of ["macos", "appimage", "deb", "android", "manual"] as const) {
      expect(operatorUpdate(planUpdate(runtime(channel), release)!)).toBeNull();
    }
  });

  it("falls back to the release page when the file is missing or the build is unknown", () => {
    const noDeb: Release = { ...release, assets: release.assets.filter((asset) => !asset.name.endsWith(".deb")) };
    expect(planUpdate(runtime("deb"), noDeb)?.action).toEqual({ kind: "page" });
    expect(planUpdate(runtime("manual"), release)?.action).toEqual({ kind: "page" });
    expect(offerButton(planUpdate(runtime("manual"), release)!)).toBe("Download");
  });

  it("offers nothing when the release is not newer", () => {
    for (const channel of ["macos", "appimage", "deb", "android", "web", "docker", "manual"] as const) {
      expect(planUpdate(runtime(channel, "1.5.0"), release)).toBeNull();
      expect(planUpdate(runtime(channel, "1.6.0"), release)).toBeNull();
    }
    expect(planUpdate(runtime("macos", "1.5.0-beta.1"), release)).not.toBeNull();
  });

  it("reads the native channel, defaulting to manual", () => {
    expect(parseChannel("appimage")).toBe("appimage");
    expect(parseChannel("deb")).toBe("deb");
    expect(parseChannel("windows")).toBe("manual");
    expect(parseChannel(undefined)).toBe("manual");
  });
});

describe("schedule and dismissal", () => {
  const NOW = 1_800_000_000_000;

  it("checks on first launch, then every six hours, and an hour after a failure", () => {
    const fresh = { ...DEFAULT_UPDATE_STATE };
    expect(checkDue(fresh, NOW, true)).toBe(true);
    const checked = recordCheck(fresh, NOW, true);
    expect(checkDue(checked, NOW + CHECK_INTERVAL_MS - 1, true)).toBe(false);
    expect(checkDue(checked, NOW + CHECK_INTERVAL_MS, true)).toBe(true);
    expect(msUntilDue(checked, NOW + 1000)).toBe(CHECK_INTERVAL_MS - 1000);
    const failed = recordCheck(fresh, NOW, false);
    expect(checkDue(failed, NOW + RETRY_AFTER_FAILURE_MS - 1, true)).toBe(false);
    expect(checkDue(failed, NOW + RETRY_AFTER_FAILURE_MS, true)).toBe(true);
  });

  it("never checks offline or with automatic checks off", () => {
    expect(checkDue(DEFAULT_UPDATE_STATE, NOW, false)).toBe(false);
    expect(checkDue({ ...DEFAULT_UPDATE_STATE, auto: false }, NOW, true)).toBe(false);
  });

  it("treats a last check in the future (clock went back) as due", () => {
    expect(checkDue(recordCheck(DEFAULT_UPDATE_STATE, NOW + 1e9, true), NOW, true)).toBe(true);
    expect(msUntilDue(recordCheck(DEFAULT_UPDATE_STATE, NOW + 1e9, true), NOW)).toBe(0);
  });

  it("announces a version once: not again once dismissed, but a newer one is", () => {
    const offer = planUpdate(runtime("macos"), release)!;
    expect(shouldAnnounce(offer, DEFAULT_UPDATE_STATE)).toBe(true);
    const after = dismiss(DEFAULT_UPDATE_STATE, "1.5.0");
    expect(shouldAnnounce(offer, after)).toBe(false);
    const newer = planUpdate(runtime("macos"), { ...release, version: "1.5.1" })!;
    expect(shouldAnnounce(newer, after)).toBe(true);
    expect(shouldAnnounce(null, DEFAULT_UPDATE_STATE)).toBe(false);
  });

  it("never moves the dismissal backwards", () => {
    const at151 = dismiss(DEFAULT_UPDATE_STATE, "1.5.1");
    expect(dismiss(at151, "1.5.0")).toBe(at151);
    expect(dismiss(at151, "1.6.0").dismissed).toBe("1.6.0");
  });

  it("round-trips the stored state and tolerates junk", () => {
    const state = { auto: false, lastCheckAt: NOW, lastCheckFailed: true, dismissed: "1.5.0" };
    expect(parseUpdateState(serialiseUpdateState(state))).toEqual(state);
    expect(parseUpdateState(null)).toEqual(DEFAULT_UPDATE_STATE);
    expect(parseUpdateState("{not json")).toEqual(DEFAULT_UPDATE_STATE);
    expect(parseUpdateState("42")).toEqual(DEFAULT_UPDATE_STATE);
    expect(parseUpdateState('{"auto":"no","lastCheckAt":-5,"dismissed":"soon"}')).toEqual(DEFAULT_UPDATE_STATE);
  });
});

describe("checkForUpdate", () => {
  const respond = (status: number, body: unknown) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  it("offers a newer release", async () => {
    const result = await checkForUpdate(runtime("deb"), respond(200, githubRelease()));
    expect(result.kind).toBe("offer");
  });

  it("says current when nothing is newer, or no release exists yet", async () => {
    expect(await checkForUpdate(runtime("deb", "1.5.0"), respond(200, githubRelease()))).toEqual({
      kind: "current",
      latest: "1.5.0",
    });
    expect(await checkForUpdate(runtime("deb"), respond(404, {}))).toEqual({ kind: "current", latest: null });
  });

  it("fails without throwing on errors, rate limits and junk", async () => {
    expect((await checkForUpdate(runtime("deb"), respond(403, {}))).kind).toBe("failed");
    expect((await checkForUpdate(runtime("deb"), respond(200, { tag_name: "x" }))).kind).toBe("failed");
    const offline = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await checkForUpdate(runtime("deb"), offline)).toEqual({ kind: "failed", reason: "Failed to fetch" });
  });

  it("asks GitHub's latest-release endpoint", async () => {
    let asked = "";
    await checkForUpdate(runtime("web"), async (url) => {
      asked = url;
      return { ok: true, status: 200, json: async () => githubRelease() };
    });
    expect(asked).toBe("https://api.github.com/repos/hxmbl/winnow/releases/latest");
  });
});

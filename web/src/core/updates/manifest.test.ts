import { describe, expect, it } from "vitest";
import { APPIMAGE_KEYS, MAC_KEYS, assetUrl, buildManifest } from "./manifest";

const input = {
  version: "1.5.0",
  tag: "v1.5.0",
  repo: "hxmbl/winnow",
  notes: "## What's Changed\n* Automatic updates",
  pubDate: "2026-10-21T18:00:00Z",
  macos: { name: "Winnow_1.5.0_universal.app.tar.gz", signature: "c2lnLW1hYw==\n" },
  appimage: { name: "Winnow_1.5.0_amd64.AppImage", signature: "c2lnLWxpbnV4" },
};

describe("latest.json", () => {
  it("points both mac architectures at the one universal tarball", () => {
    const manifest = buildManifest(input);
    const url = "https://github.com/hxmbl/winnow/releases/download/v1.5.0/Winnow_1.5.0_universal.app.tar.gz";
    for (const key of MAC_KEYS) expect(manifest.platforms[key]).toEqual({ signature: "c2lnLW1hYw==", url });
    expect(manifest.platforms["darwin-aarch64"]).toEqual(manifest.platforms["darwin-x86_64"]);
  });

  it("points Linux at the AppImage, and carries the version, notes and date", () => {
    const manifest = buildManifest(input);
    for (const key of APPIMAGE_KEYS) {
      expect(manifest.platforms[key].url).toBe(
        "https://github.com/hxmbl/winnow/releases/download/v1.5.0/Winnow_1.5.0_amd64.AppImage",
      );
    }
    expect(manifest.version).toBe("1.5.0");
    expect(manifest.notes).toContain("Automatic updates");
    expect(manifest.pub_date).toBe("2026-10-21T18:00:00Z");
    expect(Object.keys(manifest.platforms).sort()).toEqual([...MAC_KEYS, ...APPIMAGE_KEYS].sort());
  });

  it("leaves out a platform whose build is missing, and refuses an empty one", () => {
    expect(Object.keys(buildManifest({ ...input, macos: null }).platforms).sort()).toEqual([...APPIMAGE_KEYS].sort());
    expect(() => buildManifest({ ...input, macos: null, appimage: null })).toThrow(/no signed/);
    expect(() => buildManifest({ ...input, appimage: { name: "x.AppImage", signature: "  " } })).toThrow(/empty signature/);
  });

  it("escapes asset names in URLs", () => {
    expect(assetUrl("hxmbl/winnow", "v1.5.0", "a b.tar.gz")).toBe(
      "https://github.com/hxmbl/winnow/releases/download/v1.5.0/a%20b.tar.gz",
    );
  });
});

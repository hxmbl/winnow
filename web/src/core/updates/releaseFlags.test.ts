import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createFlags, isPrereleaseTag, publishFlags } from "./releaseFlags";

describe("release flags", () => {
  it("calls any tag with a dash a pre-release", () => {
    expect(isPrereleaseTag("v1.6.0-beta.1")).toBe(true);
    expect(isPrereleaseTag("v1.6.0-rc1")).toBe(true);
    expect(isPrereleaseTag("v1.6.0")).toBe(false);
  });

  it("creates a dash tag as a pre-release that is never Latest", () => {
    expect(createFlags("v1.6.0-beta.1")).toEqual(["--prerelease", "--latest=false"]);
    expect(createFlags("v1.6.0")).toEqual(["--prerelease=false"]);
  });

  it("publishes a dash tag, or one GitHub calls a pre-release, as a pre-release and never Latest", () => {
    expect(publishFlags("v1.6.0-beta.1", false)).toEqual(["--draft=false", "--prerelease", "--latest=false"]);
    expect(publishFlags("v1.6.0-beta.1", true)).toEqual(["--draft=false", "--prerelease", "--latest=false"]);
    expect(publishFlags("v1.6.0", true)).toEqual(["--draft=false", "--prerelease", "--latest=false"]);
    expect(publishFlags("v1.6.0", false)).toEqual(["--draft=false", "--latest"]);
  });

  it("is what the workflow's script prints", () => {
    const script = fileURLToPath(new URL("../../../scripts/release-flags.mjs", import.meta.url));
    const run = (...args: string[]) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8" }).trim().split("\n");
    expect(run("create", "v1.6.0-beta.1")).toEqual(["--prerelease", "--latest=false"]);
    expect(run("publish", "v1.6.0", "false")).toEqual(["--draft=false", "--latest"]);
    expect(run("prerelease", "v1.6.0-beta.1")).toEqual(["true"]);
  });
});

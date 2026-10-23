/**
 * How the release workflow marks a release (`.github/workflows/release.yml`, through
 * `web/scripts/release-flags.mjs`): the one rule that keeps a pre-release away from
 * everyone on the stable channel.
 *
 * **Any tag with a `-` in it (`v1.6.0-beta.1`) is a pre-release**, whatever else says
 * otherwise: it is created as a GitHub pre-release, published as one, and never marked
 * "Latest". That matters because the stable channel's every path reads "latest" —
 * `releases/latest` (the app's check, the Docker image's fetch) and
 * `releases/latest/download/latest.json` (Tauri's updater) — so a pre-release marked
 * latest would reach every installed copy. Each of those also refuses a `-` tag on its
 * own (`updates.ts`, `updater.rs`, `UpdateLogic.kt`, `docker/fetch-release.sh`); this is
 * the half that keeps GitHub's own answer right. A pre-release's `latest.json` is
 * attached to that release only, so it never replaces the stable one.
 *
 * Pure and dependency-free, so the script runs it straight from TypeScript.
 */

/** A pre-release tag: anything with a `-`. */
export function isPrereleaseTag(tag: string): boolean {
  return tag.includes("-");
}

/** `gh release create` (or, re-run, `gh release edit`) flags for the draft. */
export function createFlags(tag: string): string[] {
  return isPrereleaseTag(tag) ? ["--prerelease", "--latest=false"] : ["--prerelease=false"];
}

/**
 * `gh release edit` flags that publish the draft. A pre-release by its tag *or* by
 * GitHub's flag (someone ticked the box on the draft) stays a pre-release and is never
 * Latest; only a stable tag that GitHub also calls stable becomes Latest.
 */
export function publishFlags(tag: string, githubPrerelease: boolean): string[] {
  return isPrereleaseTag(tag) || githubPrerelease
    ? ["--draft=false", "--prerelease", "--latest=false"]
    : ["--draft=false", "--latest"];
}

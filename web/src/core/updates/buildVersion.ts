/**
 * The version a build reports, pre-release suffix included.
 *
 * Every manifest (package.json, Cargo.toml, tauri.conf.json) holds the bare version a
 * release is cut from, so a 1.6.0-beta.2 build and the final 1.6.0 both say "1.6.0" to
 * Tauri, and a beta install would think the final release was the version it already
 * had. The suffix stays out of the manifests on purpose: a `.deb` reads "1.6.0-beta.2"
 * as 1.6.0 revision beta.2, newer than 1.6.0. Instead the release workflow passes the
 * tag to the web build (`WINNOW_RELEASE_VERSION`, see `vite.config.ts`), and the app
 * reports that wherever it shows or compares its version: Settings → About and the
 * update check.
 *
 * Only a tag that extends the native version is taken, so a stale or mismatched value
 * can never make a build claim to be some other release.
 */
export function withReleaseSuffix(native: string, release: string | null | undefined): string {
  const tag = (release ?? "").trim().replace(/^v/, "");
  return tag.startsWith(`${native}-`) && /^[0-9A-Za-z.-]+$/.test(tag) ? tag : native;
}

/** The tag this bundle was built for, or "" outside a release build (and under vitest). */
export const BUILD_RELEASE = typeof __WINNOW_RELEASE__ === "string" ? __WINNOW_RELEASE__ : "";

/** `withReleaseSuffix` against this bundle's own release tag. */
export function reportedVersion(native: string): string {
  return withReleaseSuffix(native, BUILD_RELEASE);
}

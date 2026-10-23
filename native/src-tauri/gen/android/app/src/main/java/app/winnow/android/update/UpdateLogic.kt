package app.winnow.android.update

/** The checks `UpdatePlugin` makes before downloading anything. Pure, for unit tests. */
object UpdateLogic {
  /** Where every release file lives (`core/updates/updates.ts`, `RELEASE_DOWNLOAD_PREFIX`). */
  const val RELEASE_DOWNLOAD_PREFIX = "https://github.com/hxmbl/winnow/releases/download/"

  /** No release APK is anywhere near this; a bigger answer is not ours. */
  const val MAX_APK_BYTES = 400L * 1024 * 1024

  /** The checksum list every release carries (`.github/workflows/release.yml`). */
  const val SUMS_NAME = "SHA256SUMS"

  /** A checksum list is a line per asset; anything this big is not one. */
  const val MAX_SUMS_BYTES = 64L * 1024

  private val SUM_LINE = Regex("^([0-9a-fA-F]{64}) [ *](.+)$")

  private val NAME = Regex("^[A-Za-z0-9._-]+\\.apk$")

  /**
   * A signed universal APK attached to one of this repository's releases: https, the
   * repository's release downloads, no `..`, and a plain file name that is the URL's
   * last segment. Never a `-debug` APK: Android refuses it over a release-signed app.
   */
  fun isReleaseApk(url: String, name: String): Boolean {
    if (!url.startsWith(RELEASE_DOWNLOAD_PREFIX) || url.contains("..")) return false
    if (!NAME.matches(name) || name.endsWith("-debug.apk")) return false
    if (!name.contains("android-universal")) return false
    return url.substringAfterLast('/') == name
  }

  /** The release's `SHA256SUMS`, beside the file at `url` in the same release. */
  fun sumsUrl(url: String): String = url.substringBeforeLast('/') + "/" + SUMS_NAME

  /**
   * The SHA-256 `sums` (in `sha256sum`'s format) gives for `name`, lower-case, or null
   * when it lists no such file (or lists it twice, which no honest list does).
   */
  fun expectedSha256(sums: String, name: String): String? {
    val found = sums.lineSequence()
      .map { it.trimEnd('\r') }
      .mapNotNull { SUM_LINE.matchEntire(it) }
      .filter { it.groupValues[2] == name }
      .map { it.groupValues[1].lowercase() }
      .toList()
    return found.singleOrNull()
  }
}

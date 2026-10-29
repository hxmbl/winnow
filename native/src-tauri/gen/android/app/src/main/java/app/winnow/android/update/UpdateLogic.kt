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

  /** Why a pre-release's APK is refused without Beta updates. */
  const val PRERELEASE_REFUSED =
    "that release is a pre-release; it is offered only with Beta updates on (Dev Options)"

  /** The tag a release download belongs to: the path segment after `/releases/download/`. */
  fun releaseTag(url: String): String? {
    if (!url.startsWith(RELEASE_DOWNLOAD_PREFIX)) return null
    return url.removePrefix(RELEASE_DOWNLOAD_PREFIX).substringBefore('/').ifEmpty { null }
  }

  /**
   * A download from a pre-release: its tag has a `-` (`v1.6.0-beta.1`). Refused unless
   * the offer came from the Beta channel, whatever GitHub's flags say: the backstop if a
   * pre-release is ever marked latest by mistake.
   */
  fun isPrereleaseDownload(url: String): Boolean = releaseTag(url)?.contains('-') == true

  /**
   * A signed universal APK attached to one of this repository's releases: https, the
   * repository's release downloads, no `..`, a plain file name that is the URL's last
   * segment, and a stable tag (no `-`) unless `allowPrerelease` (Beta updates). Never a
   * `-debug` APK: Android refuses it over a release-signed app.
   */
  fun isReleaseApk(url: String, name: String, allowPrerelease: Boolean = false): Boolean {
    if (!url.startsWith(RELEASE_DOWNLOAD_PREFIX) || url.contains("..")) return false
    val tag = releaseTag(url) ?: return false
    if (tag.contains('-') && !allowPrerelease) return false
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

  /** Without a size, a download is reported once per this many bytes. */
  const val UNSIZED_STEP = 512L * 1024

  /**
   * Whether a download that has reached `received` bytes (of `total`, null when the
   * server gave no size) is worth reporting, when the last report was at `last` (-1
   * before the first): once per whole percent with a size, once per `UNSIZED_STEP`
   * without, always the first and the last, never backwards. Same rule as
   * `worth_reporting` in `updater.rs`.
   */
  fun worthReporting(last: Long, received: Long, total: Long?): Boolean {
    if (last < 0) return true
    if (received <= last) return false
    if (total != null && total > 0) {
      return received >= total || received * 100 / total > last * 100 / total
    }
    return received - last >= UNSIZED_STEP
  }
}

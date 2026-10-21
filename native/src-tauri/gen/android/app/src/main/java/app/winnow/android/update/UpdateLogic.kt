package app.winnow.android.update

/** The checks `UpdatePlugin` makes before downloading anything. Pure, for unit tests. */
object UpdateLogic {
  /** Where every release file lives (`core/updates/updates.ts`, `RELEASE_DOWNLOAD_PREFIX`). */
  const val RELEASE_DOWNLOAD_PREFIX = "https://github.com/hxmbl/winnow/releases/download/"

  /** No release APK is anywhere near this; a bigger answer is not ours. */
  const val MAX_APK_BYTES = 400L * 1024 * 1024

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
}

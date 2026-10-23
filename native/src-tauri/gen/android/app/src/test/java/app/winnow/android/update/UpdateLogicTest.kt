package app.winnow.android.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateLogicTest {
  private val base = "https://github.com/hxmbl/winnow/releases/download/v1.5.0/"
  private val name = "Winnow_1.5.0_android-universal.apk"

  @Test
  fun acceptsTheReleaseApk() {
    assertTrue(UpdateLogic.isReleaseApk(base + name, name))
  }

  @Test
  fun refusesAnythingElse() {
    assertFalse(UpdateLogic.isReleaseApk("http://github.com/hxmbl/winnow/releases/download/v1.5.0/$name", name))
    assertFalse(UpdateLogic.isReleaseApk("https://evil.example/$name", name))
    assertFalse(UpdateLogic.isReleaseApk("https://github.com/other/winnow/releases/download/v1/$name", name))
    assertFalse(UpdateLogic.isReleaseApk(base + "../../$name", name))
    assertFalse(UpdateLogic.isReleaseApk(base + "Winnow_1.5.0_android-universal-debug.apk", "Winnow_1.5.0_android-universal-debug.apk"))
    assertFalse(UpdateLogic.isReleaseApk(base + name, "other.apk"))
    assertFalse(UpdateLogic.isReleaseApk(base + "Winnow_1.5.0_amd64.deb", "Winnow_1.5.0_amd64.deb"))
    assertFalse(UpdateLogic.isReleaseApk(base + name, "../$name"))
  }

  @Test
  fun aPrereleaseApkNeedsBetaUpdates() {
    val beta = "https://github.com/hxmbl/winnow/releases/download/v1.6.0-beta.1/"
    val apk = "Winnow_1.6.0-beta.1_android-universal.apk"
    assertTrue(UpdateLogic.isPrereleaseDownload(beta + apk))
    assertFalse(UpdateLogic.isPrereleaseDownload(base + name))
    // Stable: refused by the tag, even under a stable-looking file name.
    assertFalse(UpdateLogic.isReleaseApk(beta + apk, apk))
    assertFalse(UpdateLogic.isReleaseApk(beta + name, name))
    // Beta: allowed, with every other check still applied.
    assertTrue(UpdateLogic.isReleaseApk(beta + apk, apk, allowPrerelease = true))
    assertFalse(UpdateLogic.isReleaseApk(beta + "../x/$apk", apk, allowPrerelease = true))
    assertFalse(
      UpdateLogic.isReleaseApk(beta + "Winnow_1.6.0-beta.1_android-universal-debug.apk", "Winnow_1.6.0-beta.1_android-universal-debug.apk", allowPrerelease = true),
    )
    // A stable APK is fine on either channel.
    assertTrue(UpdateLogic.isReleaseApk(base + name, name, allowPrerelease = true))
    assertEquals("v1.6.0-beta.1", UpdateLogic.releaseTag(beta + apk))
    assertNull(UpdateLogic.releaseTag("https://evil.example/v1.6.0-beta.1/$apk"))
    // The checksum still comes from the same release.
    assertEquals(beta + "SHA256SUMS", UpdateLogic.sumsUrl(beta + apk))
  }

  private val hash = "a".repeat(64)

  @Test
  fun findsTheChecksumBesideTheApk() {
    assertEquals(base + "SHA256SUMS", UpdateLogic.sumsUrl(base + name))
    val sums = "${"b".repeat(64)}  Winnow_1.5.0_amd64.deb\n${hash.uppercase()}  $name\r\n"
    assertEquals(hash, UpdateLogic.expectedSha256(sums, name))
    assertEquals(hash, UpdateLogic.expectedSha256("$hash *$name", name))
  }

  @Test
  fun noChecksumMeansNoInstall() {
    assertNull(UpdateLogic.expectedSha256("", name))
    assertNull(UpdateLogic.expectedSha256("${"b".repeat(64)}  other.apk", name))
    assertNull(UpdateLogic.expectedSha256("$hash  $name\n${"b".repeat(64)}  $name", name))
    assertNull(UpdateLogic.expectedSha256("${"a".repeat(63)}  $name", name))
    assertNull(UpdateLogic.expectedSha256("$hash  x$name", name))
  }
}

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

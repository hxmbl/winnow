package app.winnow.android.update

import org.junit.Assert.assertFalse
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
}

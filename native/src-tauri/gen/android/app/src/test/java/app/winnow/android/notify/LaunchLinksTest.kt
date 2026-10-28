package app.winnow.android.notify

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LaunchLinksTest {
  private val view = LaunchLinks.ACTION_VIEW
  private val message = "winnow://message/0?account=acct1234&gmail=18f0abc"
  private val inbox = "winnow://open?account=acct1234&view=inbox"

  @After
  fun reset() {
    LaunchLinks.clear()
  }

  @Test
  fun `a notification's tap that starts the activity is kept and taken once`() {
    assertTrue(LaunchLinks.offerLaunch(view, message, 0, restored = false, now = 1_000))
    assertEquals(listOf(message), LaunchLinks.take(now = 2_000))
    // The web layer asks on every page load: a reload must not reopen it.
    assertEquals(emptyList<String>(), LaunchLinks.take(now = 3_000))
  }

  @Test
  fun `a tap while the activity is up is kept too, for when Rust is not up to pass it on`() {
    assertTrue(LaunchLinks.offerNew(view, inbox, now = 1_000))
    assertEquals(listOf(inbox), LaunchLinks.take(now = 1_500))
  }

  @Test
  fun `only the newest tap is kept`() {
    LaunchLinks.offerLaunch(view, message, 0, restored = false, now = 1_000)
    LaunchLinks.offerNew(view, inbox, now = 1_200)
    assertEquals(listOf(inbox), LaunchLinks.take(now = 1_300))
  }

  @Test
  fun `a recreated activity or one reopened from Recents does not reopen the old tap`() {
    assertNull(LaunchLinks.launchLink(view, message, 0, restored = true))
    assertNull(LaunchLinks.launchLink(view, message, LaunchLinks.FLAG_LAUNCHED_FROM_HISTORY, restored = false))
    assertFalse(LaunchLinks.offerLaunch(view, message, LaunchLinks.FLAG_LAUNCHED_FROM_HISTORY or 0x10000000, restored = false))
    assertEquals(emptyList<String>(), LaunchLinks.take())
  }

  @Test
  fun `a launcher start or anything that is not a winnow link keeps nothing`() {
    assertNull(LaunchLinks.launchLink("android.intent.action.MAIN", null, 0, restored = false))
    assertNull(LaunchLinks.launchLink(view, null, 0, restored = false))
    assertNull(LaunchLinks.launchLink(view, "https://example.com/message/1", 0, restored = false))
    assertNull(LaunchLinks.launchLink(view, "winnow://", 0, restored = false))
    assertNull(LaunchLinks.newIntentLink(view, "winnow://message/1 x"))
    assertNull(LaunchLinks.newIntentLink(view, "winnow://message/" + "1".repeat(LaunchLinks.MAX_LENGTH)))
    assertNull(LaunchLinks.newIntentLink("android.intent.action.SEND", message))
  }

  @Test
  fun `ChromeOS's view action counts`() {
    assertEquals(message, LaunchLinks.newIntentLink(LaunchLinks.ARC_ACTION_VIEW, message))
  }

  @Test
  fun `the links Winnow's own notifications carry are accepted`() {
    for (link in listOf(message, inbox, "winnow://open", "winnow://signed-in", "winnow://message/42?gmail=abc")) {
      assertTrue(link, LaunchLinks.isWinnowLink(link))
    }
  }

  @Test
  fun `a link nobody took for two minutes is dropped`() {
    LaunchLinks.offerNew(view, message, now = 1_000)
    assertEquals(emptyList<String>(), LaunchLinks.take(now = 1_000 + LaunchLinks.MAX_AGE_MS + 1))
    // …and it is gone, not waiting for a clock that runs backwards.
    assertEquals(emptyList<String>(), LaunchLinks.take(now = 1_000))
  }
}

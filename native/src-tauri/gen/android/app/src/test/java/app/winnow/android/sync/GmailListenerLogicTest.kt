package app.winnow.android.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GmailListenerLogicTest {
  private val me = SyncAccount("abcd1234", null, true, "me@gmail.com")
  private val work = SyncAccount("work9999", "me@work.example", true, "me@work.example")
  private val accounts = listOf(me, work)

  @Test
  fun `only the Gmail app's notifications count`() {
    assertTrue(GmailListenerLogic.isGmail("com.google.android.gm"))
    for (other in listOf(null, "", "com.whatsapp", "com.google.android.gm.lite", "com.google.android.gms", "app.winnow.android", "COM.GOOGLE.ANDROID.GM")) {
      assertFalse(other.toString(), GmailListenerLogic.isGmail(other))
    }
  }

  @Test
  fun `the account named on Gmail's notification is the one synced`() {
    assertEquals(setOf("work9999"), GmailListenerLogic.accountsFor(listOf("Me@Work.example", null), accounts))
    assertEquals(setOf("abcd1234"), GmailListenerLogic.accountsFor(listOf(null, "3 new messages • me@gmail.com"), accounts))
    assertEquals(setOf("abcd1234", "work9999"), GmailListenerLogic.accountsFor(listOf("me@gmail.com", "me@work.example"), accounts))
  }

  @Test
  fun `no address, or one Winnow doesn't have, means every account`() {
    assertNull(GmailListenerLogic.accountsFor(listOf(null, null), accounts))
    assertNull(GmailListenerLogic.accountsFor(listOf("", "Inbox"), accounts))
    assertNull(GmailListenerLogic.accountsFor(listOf("someone@else.example"), accounts))
    // An account the web layer sent no address for is never matched.
    assertNull(GmailListenerLogic.accountsFor(listOf("me@gmail.com"), listOf(SyncAccount("abcd1234", null, true))))
  }

  @Test
  fun `a burst of notifications is one sync`() {
    val debounce = GmailListenerLogic.Debounce(2_000)
    assertFalse(debounce.pending())
    assertEquals(2_000L, debounce.offer(setOf("abcd1234"), "k1"))
    assertNull(debounce.offer(setOf("abcd1234"), "k2"))
    assertNull(debounce.offer(setOf("work9999"), "summary"))
    assertTrue(debounce.pending())
    val request = debounce.take()!!
    assertEquals(setOf("abcd1234", "work9999"), request.accounts)
    assertEquals(listOf("k1", "k2", "summary"), request.gmailKeys.keys.toList())
    assertFalse(debounce.pending())
    assertNull(debounce.take())
    // The next notification opens a new burst.
    assertEquals(2_000L, debounce.offer(null, "k3"))
  }

  @Test
  fun `one unmatched notification in a burst syncs every account`() {
    val debounce = GmailListenerLogic.Debounce()
    debounce.offer(setOf("abcd1234"), "k1")
    debounce.offer(null, "k2")
    val request = debounce.take()!!
    assertNull(request.accounts)
    assertEquals(setOf("abcd1234"), request.gmailKeys["k1"])
    assertNull(request.gmailKeys["k2"])
  }

  @Test
  fun `ten minutes with the listener connected, five otherwise`() {
    assertEquals(10 * 60_000L, GmailListenerLogic.pollInterval(listenerOn = true, listenerConnected = true))
    assertEquals(5 * 60_000L, GmailListenerLogic.pollInterval(listenerOn = true, listenerConnected = false))
    assertEquals(5 * 60_000L, GmailListenerLogic.pollInterval(listenerOn = false, listenerConnected = true))
    assertEquals(5 * 60_000L, GmailListenerLogic.pollInterval(listenerOn = false, listenerConnected = false))
  }

  @Test
  fun `only Gmail's own notifications, for mail Winnow posted, are taken down`() {
    val keys = mapOf("k1" to setOf("abcd1234"), "k2" to setOf("work9999"), "k3" to null, "other" to setOf("abcd1234"))
    val active = mapOf("k1" to "com.google.android.gm", "k2" to "com.google.android.gm", "k3" to "com.google.android.gm", "other" to "com.whatsapp")
    assertEquals(listOf("k1"), GmailListenerLogic.keysToCancel(keys, active, posted = setOf("abcd1234")))
    assertEquals(listOf("k1", "k2"), GmailListenerLogic.keysToCancel(keys, active, posted = setOf("abcd1234", "work9999")))
    // Nothing posted (a failed check, notifications off for the account): Gmail's stay.
    assertTrue(GmailListenerLogic.keysToCancel(keys, active, posted = emptySet()).isEmpty())
    // Gone already: nothing to cancel.
    assertTrue(GmailListenerLogic.keysToCancel(keys, emptyMap(), posted = setOf("abcd1234")).isEmpty())
  }

  @Test
  fun `a notification matched to two accounts goes only when both posted`() {
    val keys = mapOf("k" to setOf("abcd1234", "work9999"))
    val active = mapOf("k" to "com.google.android.gm")
    assertTrue(GmailListenerLogic.keysToCancel(keys, active, setOf("abcd1234")).isEmpty())
    assertEquals(listOf("k"), GmailListenerLogic.keysToCancel(keys, active, setOf("abcd1234", "work9999")))
  }

  @Test
  fun `one retry for accounts whose mail did not show up yet`() {
    val keys = mapOf("k1" to setOf("abcd1234"), "k2" to setOf("work9999"), "k3" to null)
    assertTrue(GmailListenerLogic.wantsRetry(keys, setOf("abcd1234")))
    assertEquals(setOf("work9999"), GmailListenerLogic.retryAccounts(keys, setOf("abcd1234")))
    assertFalse(GmailListenerLogic.wantsRetry(keys, setOf("abcd1234", "work9999")))
    // An unmatched notification never asks for a retry: it is never taken down anyway.
    assertFalse(GmailListenerLogic.wantsRetry(mapOf("k3" to null), emptySet()))
  }

  @Test
  fun `addresses are read case-insensitively from the account line`() {
    assertEquals(setOf("a.b+c@ex-ample.co.uk"), GmailListenerLogic.addressesIn(listOf("A.B+c@Ex-ample.co.uk")))
    assertTrue(GmailListenerLogic.addressesIn(listOf(null, "", "no address here")).isEmpty())
  }
}

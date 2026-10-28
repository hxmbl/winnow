package app.winnow.android.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncTextTest {
  @Test
  fun `specialUse from Android 14, no type before`() {
    assertEquals(0x40000000, SyncText.serviceType(34))
    assertEquals(0x40000000, SyncText.serviceType(37))
    assertEquals(0, SyncText.serviceType(33))
    assertEquals(0, SyncText.serviceType(24))
  }

  @Test
  fun `the persistent notification says when an account needs signing in again`() {
    assertEquals("Checking for new mail", SyncText.persistent(emptyList()).first)
    assertTrue(SyncText.persistent(listOf("me@example.com")).second.contains("me@example.com"))
    assertTrue(SyncText.persistent(listOf("a", "b")).second.contains("2 accounts"))
  }
}

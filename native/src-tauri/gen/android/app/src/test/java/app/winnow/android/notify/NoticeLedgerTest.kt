package app.winnow.android.notify

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NoticeLedgerTest {
  private fun e(id: String, title: String = "Sender $id", shown: Boolean = true, at: Long = id.hashCode().toLong()) =
    NoticeLedger.Entry(id, title, "Subject $id", shown, at)

  @Test
  fun `a message is announced once, whoever announces it first`() {
    val ledger = NoticeLedger(null)
    ledger.record("acct1", listOf(e("m1")))
    assertTrue(ledger.wasSeen("acct1", "m1"))
    assertFalse(ledger.wasSeen("acct2", "m1"))
    // Dismissed, it stays seen: a swiped-away notification does not come back.
    ledger.dismiss("acct1", listOf("m1"))
    assertTrue(ledger.wasSeen("acct1", "m1"))
    assertTrue(ledger.entries("acct1").isEmpty())
  }

  @Test
  fun `the summary is rebuilt from what is left, so a stale count never lingers`() {
    val ledger = NoticeLedger(null)
    ledger.record("acct1", listOf(e("m1", "Ada", at = 3), e("m2", "Bob", at = 2), e("m3", "Cy", at = 1)))
    assertEquals("3 new messages", ledger.summary("acct1")!!.title)
    ledger.dismiss("acct1", listOf("m2"))
    val two = ledger.summary("acct1")!!
    assertEquals("2 new messages", two.title)
    assertEquals("Ada, Cy", two.body)
    ledger.dismiss("acct1", listOf("m1"))
    // One left: the summary names it (an up summary is updated, never cancelled early).
    assertEquals("Sender m3".replace("Sender m3", "Cy"), ledger.summary("acct1")!!.title)
    ledger.dismiss("acct1", listOf("m3"))
    assertNull(ledger.summary("acct1"))
  }

  @Test
  fun `messages past the five count in the summary until their own notifications are gone`() {
    val ledger = NoticeLedger(null)
    ledger.record("acct1", (1..5).map { e("s$it", at = it.toLong()) } + listOf(e("r1", "", shown = false), e("r2", "", shown = false)))
    val summary = ledger.summary("acct1")!!
    assertEquals("7 new messages", summary.title)
    assertEquals(5, summary.lines.size)
    assertEquals("+2 more", summary.more)
    // The user swiped every message notification away: the summary-only ones go too.
    ledger.reconcile("acct1", emptySet())
    assertNull(ledger.summary("acct1"))
  }

  @Test
  fun `reconcile drops what Android no longer shows and keeps the rest`() {
    val ledger = NoticeLedger(null)
    ledger.record(null, listOf(e("a"), e("b")))
    assertTrue(ledger.reconcile(null, setOf("b")))
    assertEquals(listOf("b"), ledger.entries(null).map { it.gmailId })
    assertFalse(ledger.reconcile(null, setOf("b")))
  }

  @Test
  fun `signing out forgets the account entirely and only that account`() {
    val ledger = NoticeLedger(null)
    ledger.record("acct1", listOf(e("m1")))
    ledger.record("acct2", listOf(e("m9")))
    ledger.clearAccount("acct1")
    assertTrue(ledger.entries("acct1").isEmpty())
    assertFalse(ledger.wasSeen("acct1", "m1"))
    assertEquals(1, ledger.entries("acct2").size)
  }

  @Test
  fun `it survives being saved and read back, and a corrupt copy forgets`() {
    val ledger = NoticeLedger(null)
    ledger.record("acct1", listOf(e("m1"), e("r1", "", shown = false)))
    val copy = NoticeLedger(ledger.serialize())
    assertEquals(ledger.entries("acct1"), copy.entries("acct1"))
    assertTrue(copy.wasSeen("acct1", "r1"))
    assertTrue(NoticeLedger("{not json").entries("acct1").isEmpty())
  }

  @Test
  fun `seen is bounded`() {
    val ledger = NoticeLedger(null)
    ledger.record("a", (1..NoticeLedger.MAX_SEEN + 10).map { e("m$it") })
    assertFalse(ledger.wasSeen("a", "m1"))
    assertTrue(ledger.wasSeen("a", "m${NoticeLedger.MAX_SEEN + 10}"))
  }
}

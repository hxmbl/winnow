package app.winnow.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResumeRepaintTest {
  @Test
  fun `back from the browser redraws on resume and again on focus`() {
    val repaint = ResumeRepaint()
    repaint.onFocus(false)
    repaint.onStop()
    assertTrue(repaint.onResume())
    assertTrue(repaint.onFocus(true))
  }

  @Test
  fun `the redraw is done once focus is back`() {
    val repaint = ResumeRepaint()
    repaint.onStop()
    repaint.onResume()
    repaint.onFocus(true)
    assertFalse(repaint.onResume())
    assertFalse(repaint.onFocus(true))
  }

  @Test
  fun `a pause that never stopped the activity keeps its picture`() {
    val repaint = ResumeRepaint()
    assertFalse(repaint.onResume())
    assertFalse(repaint.onFocus(false))
    assertFalse(repaint.onFocus(true))
  }

  @Test
  fun `losing focus while still out of sight does not end the redraw`() {
    val repaint = ResumeRepaint()
    repaint.onStop()
    assertFalse(repaint.onFocus(false))
    assertTrue(repaint.onResume())
    assertTrue(repaint.onFocus(true))
  }
}

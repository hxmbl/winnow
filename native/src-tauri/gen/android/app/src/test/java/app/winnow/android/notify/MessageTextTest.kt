package app.winnow.android.notify

import org.junit.Assert.assertEquals
import org.junit.Test

class MessageTextTest {
  @Test
  fun theSenderIsTheTitleAndTheSubjectTheLineUnderIt() {
    val text = MessageText.of("Reddit", "Your post is trending", "People are talking about it")
    assertEquals("Reddit", text.title)
    assertEquals("Your post is trending", text.text)
    assertEquals("Your post is trending\nPeople are talking about it", text.bigText)
  }

  @Test
  fun withNoPreviewExpandedShowsTheSubjectAlone() {
    assertEquals("Hi", MessageText.of("Ada", "Hi", "").bigText)
    assertEquals("Hi", MessageText.of("Ada", "Hi", "  ").bigText)
    assertEquals("Hi", MessageText.of("Ada", "Hi", null).bigText)
  }

  @Test
  fun aMissingSenderOrSubjectIsNamedRatherThanBlank() {
    val text = MessageText.of(" ", "", "Body")
    assertEquals(MessageText.NO_SENDER, text.title)
    assertEquals(MessageText.NO_SUBJECT, text.text)
    assertEquals("${MessageText.NO_SUBJECT}\nBody", text.bigText)
  }
}

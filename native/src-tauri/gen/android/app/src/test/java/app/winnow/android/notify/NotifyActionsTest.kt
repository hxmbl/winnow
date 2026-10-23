package app.winnow.android.notify

import org.junit.Assert.assertEquals
import org.junit.Test

class NotifyActionsTest {
  @Test
  fun gmailsOrderDeleteThenMarkReadThenReply() {
    assertEquals(listOf(MailAction.DELETE, MailAction.READ, MailAction.REPLY), NotifyActions.shown(7, canReply = true))
  }

  @Test
  fun eachSwitchInSettingsDropsOnlyItsOwnButton() {
    assertEquals(listOf(MailAction.READ, MailAction.REPLY), NotifyActions.shown(1 or 4, canReply = true))
    assertEquals(listOf(MailAction.DELETE, MailAction.REPLY), NotifyActions.shown(1 or 2, canReply = true))
    assertEquals(listOf(MailAction.DELETE, MailAction.READ), NotifyActions.shown(2 or 4, canReply = true))
    assertEquals(emptyList<MailAction>(), NotifyActions.shown(0, canReply = true))
  }

  @Test
  fun replyNeedsItsReplyHead() {
    assertEquals(listOf(MailAction.DELETE, MailAction.READ), NotifyActions.shown(7, canReply = false))
  }
}

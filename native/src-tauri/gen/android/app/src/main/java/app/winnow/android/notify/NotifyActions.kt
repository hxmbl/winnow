package app.winnow.android.notify

/** A button on a new-mail notification. */
enum class MailAction { DELETE, READ, REPLY }

/**
 * Which buttons a new-mail notification shows, and in which order: Gmail's, left to
 * right Delete, Mark read, Reply (the owner compared the two side by side), with
 * Winnow's own labels.
 *
 * Plain Kotlin, so the order is a JVM unit test (`NotifyActionsTest`).
 */
object NotifyActions {
  /** Gmail's order, left to right. */
  val ORDER: List<MailAction> = listOf(MailAction.DELETE, MailAction.READ, MailAction.REPLY)

  /**
   * The buttons for the web layer's flags (1 reply, 2 delete, 4 mark read; Settings ›
   * Notifications), in [ORDER]. Reply also needs the reply head the web layer built.
   */
  fun shown(flags: Int, canReply: Boolean): List<MailAction> =
    ORDER.filter {
      when (it) {
        MailAction.DELETE -> flags and 2 != 0
        MailAction.READ -> flags and 4 != 0
        MailAction.REPLY -> flags and 1 != 0 && canReply
      }
    }
}

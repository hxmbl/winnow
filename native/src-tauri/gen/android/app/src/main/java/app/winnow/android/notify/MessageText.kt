package app.winnow.android.notify

/**
 * The words of one message's notification, as Gmail lays them out: the sender as the
 * title, the subject as the collapsed line, and expanded, the subject over the preview.
 *
 * Plain Kotlin with no Android types, so the mapping is a JVM unit test
 * (`MessageTextTest`) rather than something only a device shows.
 */
data class MessageText(val title: String, val text: String, val bigText: String) {
  companion object {
    /** What a message with no sender name is called (a blank title would show the app name). */
    const val NO_SENDER = "Someone"
    const val NO_SUBJECT = "(no subject)"

    fun of(sender: String?, subject: String?, preview: String?): MessageText {
      val title = sender?.trim().orEmpty().ifEmpty { NO_SENDER }
      val line = subject?.trim().orEmpty().ifEmpty { NO_SUBJECT }
      val body = preview?.trim().orEmpty()
      return MessageText(title, line, if (body.isEmpty()) line else "$line\n$body")
    }
  }
}

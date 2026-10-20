package app.winnow.android.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import app.tauri.plugin.JSObject
import java.util.UUID
import org.json.JSONObject

/**
 * A button pressed on a mail notification: Reply (with its text), Delete, Mark read,
 * or Undo after Delete.
 *
 * In order, and the order is the guarantee:
 *   1. A reply's text is written to [PendingReplies] before anything else happens.
 *   2. The notification shows what is happening ("Sending…"), which also takes the
 *      buttons away and ends RemoteInput's spinner.
 *   3. Rust is asked to do it (`android.rs` → `plan.rs`). It answers with `finish`.
 * With no Rust in this process (Android restarted the app just to deliver this press),
 * step 3 is a failure notification and the reply waits for the next launch.
 */
class NotifyActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val extras = intent.extras ?: return
    val action = extras.getString(MailNotifier.EXTRA_ACTION) ?: return
    if (action !in ACTIONS) return
    val gmailId = extras.getString(MailNotifier.EXTRA_GMAIL_ID) ?: return
    val id = extras.getInt(MailNotifier.EXTRA_NOTIFICATION_ID)

    val reply = if (action == "reply") {
      RemoteInput.getResultsFromIntent(intent)?.getCharSequence(MailNotifier.KEY_REPLY)?.toString()
    } else {
      null
    }
    if (action == "reply" && reply.isNullOrBlank()) {
      // Nothing typed: put the notification back as it was.
      NotifierCompat.repost(context, extras)
      return
    }

    val requestId = UUID.randomUUID().toString()
    if (reply != null) {
      PendingReplies.put(
        context,
        requestId,
        JSONObject()
          .put("gmailId", gmailId)
          .put("threadId", extras.getString(MailNotifier.EXTRA_THREAD_ID))
          .put("messageId", extras.getLong(MailNotifier.EXTRA_MESSAGE_ID))
          .put("title", extras.getString(MailNotifier.EXTRA_TITLE))
          .put("subject", extras.getString(MailNotifier.EXTRA_SUBJECT))
          .put("replyHead", extras.getString(MailNotifier.EXTRA_REPLY_HEAD))
          .put("reply", reply)
          .put("account", MailNotifier.validAccount(extras.getString(MailNotifier.EXTRA_ACCOUNT)))
          .put("at", System.currentTimeMillis()),
      )
    }

    val marked = MailNotifier.markAction(extras, action)
    MailNotifier.working(context, requestId, marked, LABELS[action] ?: "Working…")

    val handler = NotifyPlugin.handler
    if (handler == null) {
      MailNotifier.finishLocally(context, requestId, marked, action, "Winnow wasn't running.")
      return
    }
    val request = JSObject()
    request.put("requestId", requestId)
    request.put("action", action)
    request.put("notificationId", id)
    request.put("messageId", extras.getLong(MailNotifier.EXTRA_MESSAGE_ID))
    request.put("gmailId", gmailId)
    request.put("threadId", extras.getString(MailNotifier.EXTRA_THREAD_ID))
    request.put("replyHead", extras.getString(MailNotifier.EXTRA_REPLY_HEAD))
    request.put("reply", reply)
    // The notification's account: Rust acts with that account's tokens (`plan::tokens_secret_for`).
    MailNotifier.validAccount(extras.getString(MailNotifier.EXTRA_ACCOUNT))?.let { request.put("account", it) }
    try {
      handler.send(request)
    } catch (_: Exception) {
      MailNotifier.finishLocally(context, requestId, marked, action, "Winnow wasn't running.")
    }
  }

  companion object {
    val ACTIONS = setOf("reply", "trash", "read", "untrash")
    val LABELS = mapOf(
      "reply" to "Sending…",
      "trash" to "Moving to Trash…",
      "read" to "Marking as read…",
      "untrash" to "Moving back to Inbox…",
    )
  }
}

/** Kept apart so the receiver reads as its four steps. */
internal object NotifierCompat {
  fun repost(context: Context, extras: android.os.Bundle) {
    try {
      androidx.core.app.NotificationManagerCompat.from(context)
        .notify(extras.getInt(MailNotifier.EXTRA_NOTIFICATION_ID), MailNotifier.message(context, extras))
    } catch (_: SecurityException) {
    }
  }
}

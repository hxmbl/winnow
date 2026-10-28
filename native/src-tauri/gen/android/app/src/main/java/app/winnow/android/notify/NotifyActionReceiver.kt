package app.winnow.android.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import app.tauri.plugin.JSObject
import app.winnow.android.sync.GmailCheck
import app.winnow.android.sync.HttpsTransport
import app.winnow.android.sync.KeyringFormat
import app.winnow.android.sync.KeyringReader
import app.winnow.android.sync.TokenMemory
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
 * With no Rust in this process (Android restarted the app just to deliver this press, or
 * only background sync is running), Delete, Mark read and Undo are done in Kotlin
 * ([BackgroundActions]); a reply becomes a failure notification and waits for the next
 * launch.
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
      // No Rust in this process: Android started it for background sync, not the app.
      // Delete, Mark read and Undo are one label change each, which the Kotlin side can
      // make with the same stored tokens (`sync/GmailCheck.act`). A reply cannot: it is
      // kept on the phone until Winnow opens, as before.
      if (action != "reply") {
        val pending = goAsync()
        BackgroundActions.run(context, requestId, id, action, gmailId, extras) { pending.finish() }
        return
      }
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

/**
 * A notification button answered in Kotlin, with no Rust: the label change
 * (`GmailCheck.act`), then the notification says what happened, in the words
 * `plan::finish_for` uses.
 */
internal object BackgroundActions {
  private val io = java.util.concurrent.Executors.newSingleThreadExecutor()

  fun run(context: Context, requestId: String, notificationId: Int, action: String, gmailId: String, extras: android.os.Bundle, done: () -> Unit) {
    val app = context.applicationContext
    val account = MailNotifier.validAccount(extras.getString(MailNotifier.EXTRA_ACCOUNT))
    io.execute {
      try {
        val keyring = KeyringReader(app)
        val outcome = if (gmailId == MailNotifier.TEST_GMAIL_ID) {
          "test"
        } else {
          GmailCheck.act(
            account = account,
            action = action,
            gmailId = gmailId,
            tokensRaw = account?.let { keyring.get(KeyringFormat.tokensName(it)) },
            clientRaw = keyring.get(KeyringFormat.CLIENT_NAME),
            cached = account?.let { TokenMemory.get(it) },
            now = System.currentTimeMillis(),
            transport = HttpsTransport,
            cache = TokenMemory,
          )
        }
        MailNotifier.finish(app, finishFor(requestId, notificationId, outcome))
      } catch (_: Exception) {
        MailNotifier.finish(app, finishFor(requestId, notificationId, "failed"))
      } finally {
        done()
      }
    }
  }

  /** `plan::finish_for`'s words for each outcome. */
  fun finishFor(requestId: String, notificationId: Int, outcome: String): JSONObject {
    val (kind, title, text) = when (outcome) {
      "trashed" -> Triple("undo", "Moved to Trash", "")
      "read" -> Triple("done", "Marked as read", "")
      "restored" -> Triple("done", "Moved back to Inbox", "")
      "test" -> Triple("done", "Test notification", "Nothing was changed: it isn't a real message.")
      "offline" -> Triple("failed", "Couldn't do that. Open Winnow", "You're offline.")
      "auth" -> Triple("failed", "Couldn't do that. Open Winnow", "Winnow needs you to sign in again.")
      else -> Triple("failed", "Couldn't do that. Open Winnow", "Gmail didn't accept it.")
    }
    return JSONObject()
      .put("requestId", requestId)
      .put("notificationId", notificationId)
      .put("kind", kind)
      .put("title", title)
      .put("text", text)
      .put("releasePending", true)
  }
}

package app.winnow.android.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import app.winnow.android.R
import org.json.JSONObject

/**
 * Posting, updating and clearing Winnow's mail notifications.
 *
 * One BigTextStyle notification per message, laid out as Gmail's (sender, subject,
 * preview, the sender's picture as the large icon; [MessageText]), at most five (the
 * web layer caps it and Rust caps it again), in one group with an InboxStyle summary. Each carries its
 * message in its intents' extras, so a press still knows what it is about after
 * Android has killed and restarted the process.
 *
 * Buttons are broadcasts to [NotifyActionReceiver], never activities: pressing Delete
 * must not open the app. Only the body tap opens it, at `winnow://message/<id>`, which
 * is the deep link the app already routes to the message.
 */
object MailNotifier {
  const val CHANNEL = "winnow.mail"
  const val GROUP = "winnow.mail"
  const val SUMMARY_ID = 0x5717
  const val KEY_REPLY = "winnow.reply"

  const val EXTRA_ACTION = "winnow.action"
  const val EXTRA_NOTIFICATION_ID = "winnow.notificationId"
  const val EXTRA_MESSAGE_ID = "winnow.messageId"
  const val EXTRA_GMAIL_ID = "winnow.gmailId"
  const val EXTRA_THREAD_ID = "winnow.threadId"
  const val EXTRA_TITLE = "winnow.title"
  const val EXTRA_SUBJECT = "winnow.subject"
  const val EXTRA_PREVIEW = "winnow.preview"
  const val EXTRA_RECEIVED_AT = "winnow.receivedAt"
  const val EXTRA_REPLY_HEAD = "winnow.replyHead"
  const val EXTRA_ACTIONS = "winnow.actions"
  const val EXTRA_HIDE = "winnow.hidePreview"
  const val EXTRA_PICTURE = "winnow.picture"
  /** The account the notification is for (1.4.0), and its address when several are signed in. */
  const val EXTRA_ACCOUNT = "winnow.account"
  const val EXTRA_ACCOUNT_LABEL = "winnow.accountLabel"

  /** `accounts.ts`'s `isAccountId`; anything else is treated as no account. */
  private val ACCOUNT_ID = Regex("^[a-z0-9]{4,24}$")
  fun validAccount(id: String?): String? = id?.takeIf { ACCOUNT_ID.matches(it) }

  /** Same cap as Rust's `MAX_PICTURE_CHARS` and the web layer's `NATIVE_PICTURE_MAX_CHARS`. */
  private const val MAX_PICTURE_CHARS = 200_000

  /** If Rust has not answered a press by then, the notification says so. */
  private const val WATCHDOG_MS = 60_000L
  private const val CONFIRM_MS = 2_500L
  private const val UNDO_MS = 6_000L

  private val main = Handler(Looper.getMainLooper())

  /** Presses Rust is working on, by request id: the original message, for restore and the watchdog. */
  private val inFlight = HashMap<String, Bundle>()

  /** One notification per message per account: the same Gmail id in two accounts is two messages. */
  fun idFor(gmailId: String, account: String? = null): Int {
    val id = (if (account == null) "winnow:$gmailId" else "winnow:$account:$gmailId").hashCode()
    return if (id == SUMMARY_ID || id == summaryIdFor(account)) id + 1 else id
  }

  /** Each account has its own group and summary, so one account's summary never lists another's mail. */
  fun groupFor(account: String?): String = if (account == null) GROUP else "$GROUP.$account"

  fun summaryIdFor(account: String?): Int {
    if (account == null) return SUMMARY_ID
    val id = ("winnow-summary:$account").hashCode()
    return if (id == SUMMARY_ID) id + 1 else id
  }

  /** `messageLink` in the web layer's `notifications.ts`: the exact message, in its account. */
  fun messageUri(messageId: Long, gmailId: String?, account: String?): String {
    val builder = Uri.Builder().scheme("winnow").authority("message").appendPath(messageId.toString())
    if (account != null) builder.appendQueryParameter("account", account)
    if (!gmailId.isNullOrEmpty()) builder.appendQueryParameter("gmail", gmailId)
    return builder.build().toString()
  }

  /** A summary of several messages opens the account's inbox. */
  fun inboxUri(account: String?): String =
    if (account == null) "winnow://open" else "winnow://open?account=$account&view=inbox"


  // ── Showing ──────────────────────────────────────────────────────────────

  fun show(context: Context, batch: JSONObject) {
    ensureChannel(context)
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return
    val messages = batch.optJSONArray("messages") ?: return
    val actions = batch.optJSONObject("actions")
    val flags = (if (actions?.optBoolean("reply", true) != false) 1 else 0) or
      (if (actions?.optBoolean("trash", true) != false) 2 else 0) or
      (if (actions?.optBoolean("read", true) != false) 4 else 0)
    val hide = batch.optBoolean("hidePreview", false)
    val accountJson = batch.optJSONObject("account")
    val account = validAccount(accountJson?.optString("id"))
    val label = if (account != null && accountJson?.isNull("label") == false) accountJson.optString("label").ifEmpty { null } else null

    val lines = ArrayList<String>()
    for (i in 0 until messages.length()) {
      val m = messages.getJSONObject(i)
      val gmailId = m.optString("gmailId")
      if (gmailId.isEmpty()) continue
      val extras = Bundle().apply {
        putInt(EXTRA_NOTIFICATION_ID, idFor(gmailId, account))
        if (account != null) putString(EXTRA_ACCOUNT, account)
        if (label != null) putString(EXTRA_ACCOUNT_LABEL, label)
        putLong(EXTRA_MESSAGE_ID, m.optLong("messageId"))
        putString(EXTRA_GMAIL_ID, gmailId)
        putString(EXTRA_THREAD_ID, if (m.isNull("threadId")) null else m.optString("threadId"))
        putString(EXTRA_TITLE, m.optString("title"))
        putString(EXTRA_SUBJECT, m.optString("subject"))
        putString(EXTRA_PREVIEW, m.optString("preview"))
        putLong(EXTRA_RECEIVED_AT, m.optLong("receivedAt"))
        putString(EXTRA_REPLY_HEAD, if (m.isNull("replyHead")) null else m.optString("replyHead"))
        putInt(EXTRA_ACTIONS, flags)
        putBoolean(EXTRA_HIDE, hide)
        // Bytes as a data URL (Rust has already dropped anything else); never with a hidden preview.
        if (!hide && !m.isNull("picture")) putString(EXTRA_PICTURE, m.optString("picture"))
      }
      post(context, extras.getInt(EXTRA_NOTIFICATION_ID), message(context, extras))
      lines.add("${m.optString("title")}  ${m.optString("subject")}")
    }

    val total = batch.optInt("total", lines.size)
    if (total >= 2) {
      val title = batch.optString("summaryTitle").ifEmpty { "$total new messages" }
      val style = NotificationCompat.InboxStyle().setSummaryText(if (total > lines.size) "+${total - lines.size} more" else null)
      lines.forEach { style.addLine(it) }
      val summary = NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_winnow)
        .setContentTitle(title)
        .setContentText(if (hide) null else batch.optString("summaryBody"))
        .setStyle(if (hide) null else style)
        .setGroup(groupFor(account))
        .setGroupSummary(true)
        .setCategory(NotificationCompat.CATEGORY_EMAIL)
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(open(context, summaryIdFor(account), inboxUri(account)))
      if (label != null) summary.setSubText(label)
      if (hide) summary.setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(publicVersion(context, title))
      post(context, summaryIdFor(account), summary.build())
    }
  }

  /** The full notification for one message, from its extras. */
  fun message(context: Context, extras: Bundle): android.app.Notification {
    val id = extras.getInt(EXTRA_NOTIFICATION_ID)
    val title = extras.getString(EXTRA_TITLE).orEmpty()
    val subject = extras.getString(EXTRA_SUBJECT).orEmpty()
    val preview = extras.getString(EXTRA_PREVIEW).orEmpty()
    val flags = extras.getInt(EXTRA_ACTIONS, 7)
    val hide = extras.getBoolean(EXTRA_HIDE, false)
    val account = validAccount(extras.getString(EXTRA_ACCOUNT))
    val label = extras.getString(EXTRA_ACCOUNT_LABEL)
    val text = MessageText.of(title, subject, preview)

    // The sender's picture, when the web layer sent one and the preview is not hidden:
    // the round large icon on the right, as Gmail draws it. Anything undecodable: none.
    val picture = if (hide) null else pictureBitmap(extras.getString(EXTRA_PICTURE))
    // Gmail's single-message layout: the sender is the title, the subject the line under
    // it, and expanded, the subject over the preview. Not MessagingStyle: One UI (and
    // stock Android) draws its conversation title (the subject) as the headline and the
    // message as "Sender: text", which put the subject first and the sender in the body.
    val style = NotificationCompat.BigTextStyle().bigText(text.bigText)

    val builder = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_winnow)
      .setContentTitle(text.title)
      .setContentText(text.text)
      .setStyle(style)
      .setGroup(groupFor(account))
      .setCategory(NotificationCompat.CATEGORY_EMAIL)
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      // The exact message, in its account: the app opens it in the reader (fetching it
      // first if the cache does not have it yet).
      .setContentIntent(open(context, id, messageUri(extras.getLong(EXTRA_MESSAGE_ID), extras.getString(EXTRA_GMAIL_ID), account)))
    if (label != null) builder.setSubText(label)
    if (picture != null) builder.setLargeIcon(picture)
    val receivedAt = extras.getLong(EXTRA_RECEIVED_AT)
    if (receivedAt > 0) builder.setWhen(receivedAt).setShowWhen(true)
    if (hide) {
      builder.setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(publicVersion(context, "New message"))
    }

    // Gmail's order, left to right: Delete, Mark read, Reply ([NotifyActions]).
    for (action in NotifyActions.shown(flags, canReply = extras.getString(EXTRA_REPLY_HEAD) != null)) {
      when (action) {
        MailAction.DELETE -> builder.addAction(
          NotificationCompat.Action.Builder(0, "Delete", broadcast(context, extras, "trash"))
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_DELETE)
            .setShowsUserInterface(false)
            .build(),
        )
        MailAction.READ -> builder.addAction(
          NotificationCompat.Action.Builder(0, "Mark read", broadcast(context, extras, "read"))
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build(),
        )
        MailAction.REPLY -> builder.addAction(
          NotificationCompat.Action.Builder(0, "Reply", broadcast(context, extras, "reply", mutable = true))
            .addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel("Reply").build())
            .setAllowGeneratedReplies(false)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build(),
        )
      }
    }
    return builder.build()
  }

  /**
   * A `data:image/png|jpeg;base64,` picture as a bitmap, or null: no picture, too long,
   * another scheme (never fetched here), bad base64 or bytes Android cannot decode.
   */
  fun pictureBitmap(picture: String?): Bitmap? {
    if (picture == null || picture.length > MAX_PICTURE_CHARS) return null
    val comma = picture.indexOf(',')
    val header = if (comma > 0) picture.substring(0, comma) else return null
    if (header != "data:image/png;base64" && header != "data:image/jpeg;base64") return null
    return try {
      val bytes = Base64.decode(picture.substring(comma + 1), Base64.DEFAULT)
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    } catch (e: IllegalArgumentException) {
      null
    } catch (e: OutOfMemoryError) {
      null
    }
  }

  // ── While Rust works, and after ──────────────────────────────────────────

  /** Replace the buttons with what is happening, so a second press cannot start a second action. */
  fun working(context: Context, requestId: String, extras: Bundle, label: String) {
    synchronized(inFlight) { inFlight[requestId] = extras }
    val id = extras.getInt(EXTRA_NOTIFICATION_ID)
    post(context, id, status(context, extras, label, null).setProgress(0, 0, true).setOngoing(true).build())
    main.postDelayed({
      val stale = synchronized(inFlight) { inFlight.remove(requestId) } ?: return@postDelayed
      failed(context, stale, extras.getString(EXTRA_ACTION_NAME) ?: "", "Winnow didn't finish that.")
    }, WATCHDOG_MS)
  }

  private const val EXTRA_ACTION_NAME = "winnow.actionName"

  /** `plan::Finish` from Rust. */
  fun finish(context: Context, finish: JSONObject) {
    val requestId = finish.optString("requestId")
    val extras = synchronized(inFlight) { inFlight.remove(requestId) }
    if (finish.optBoolean("releasePending", false)) PendingReplies.remove(context, requestId)
    val id = finish.optInt("notificationId")
    val title = finish.optString("title")
    val text = finish.optString("text")
    when (finish.optString("kind")) {
      "restore" -> if (extras != null) post(context, id, message(context, extras)) else cancel(context, id)
      "undo" -> {
        val base = extras ?: Bundle().apply { putInt(EXTRA_NOTIFICATION_ID, id) }
        val builder = status(context, base, title, text.ifEmpty { null }).setTimeoutAfter(UNDO_MS)
        if (base.getString(EXTRA_GMAIL_ID) != null) {
          builder.addAction(NotificationCompat.Action.Builder(0, "Undo", broadcast(context, base, "untrash")).build())
        }
        post(context, id, builder.build())
        later(context, id, UNDO_MS)
      }
      "failed" -> post(context, id, failure(context, extras, id, title, text))
      else -> {
        post(context, id, status(context, extras ?: Bundle().apply { putInt(EXTRA_NOTIFICATION_ID, id) }, title, text.ifEmpty { null }).setTimeoutAfter(CONFIRM_MS).build())
        later(context, id, CONFIRM_MS)
      }
    }
  }

  /** No Rust to hand the press to: say so now rather than after the watchdog. */
  fun finishLocally(context: Context, requestId: String, extras: Bundle, action: String, why: String) {
    synchronized(inFlight) { inFlight.remove(requestId) }
    failed(context, extras, action, why)
  }

  /** No Rust to ask (the process was restarted for this press), or it did not answer. */
  fun failed(context: Context, extras: Bundle, action: String, why: String) {
    val id = extras.getInt(EXTRA_NOTIFICATION_ID)
    val title = if (action == "reply") "Couldn't send. Open Winnow" else "Couldn't do that. Open Winnow"
    val text = if (action == "reply") "$why Your reply is kept on this phone until Winnow opens." else why
    post(context, id, failure(context, extras, id, title, text))
  }

  private fun failure(context: Context, extras: Bundle?, id: Int, title: String, text: String): android.app.Notification {
    val account = validAccount(extras?.getString(EXTRA_ACCOUNT))
    val target = extras?.getLong(EXTRA_MESSAGE_ID)?.let { messageUri(it, extras.getString(EXTRA_GMAIL_ID), account) } ?: inboxUri(account)
    return NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_winnow)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setGroup(groupFor(account))
      .setCategory(NotificationCompat.CATEGORY_ERROR)
      .setAutoCancel(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(open(context, id, target))
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion(context, title))
      .build()
  }

  private fun status(context: Context, extras: Bundle, title: String, text: String?): NotificationCompat.Builder {
    val id = extras.getInt(EXTRA_NOTIFICATION_ID)
    val messageId = extras.getLong(EXTRA_MESSAGE_ID, -1)
    val account = validAccount(extras.getString(EXTRA_ACCOUNT))
    return NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_winnow)
      .setContentTitle(title)
      .setContentText(text ?: extras.getString(EXTRA_TITLE))
      .setGroup(groupFor(account))
      .setCategory(NotificationCompat.CATEGORY_EMAIL)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setAutoCancel(true)
      .setContentIntent(open(context, id, if (messageId >= 0) messageUri(messageId, extras.getString(EXTRA_GMAIL_ID), account) else inboxUri(account)))
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion(context, title))
  }

  private fun publicVersion(context: Context, text: String): android.app.Notification =
    NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_winnow)
      .setContentTitle("Winnow")
      .setContentText(text)
      .setGroup(GROUP)
      .build()

  // ── Plumbing ─────────────────────────────────────────────────────────────

  /** Cancel after `delay` (`setTimeoutAfter` is Android 8+; this covers 7). */
  private fun later(context: Context, id: Int, delay: Long) {
    main.postDelayed({ cancel(context, id) }, delay)
  }

  fun cancel(context: Context, id: Int) {
    val manager = NotificationManagerCompat.from(context)
    // The last child of its account's group gone: that group's summary goes too, or it
    // lingers over nothing. The group is read before the child is cancelled.
    val system = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) context.getSystemService(NotificationManager::class.java) else null
    val group = system?.activeNotifications?.firstOrNull { it.id == id }?.notification?.group
    manager.cancel(id)
    if (system != null && group != null) {
      val active = system.activeNotifications
      val isSummary = { n: android.app.Notification -> (n.flags and android.app.Notification.FLAG_GROUP_SUMMARY) != 0 }
      val summary = active.firstOrNull { it.notification.group == group && isSummary(it.notification) }
      val children = active.count { it.id != id && it.notification.group == group && !isSummary(it.notification) }
      if (children == 0 && summary != null) manager.cancel(summary.id)
    }
  }

  private fun post(context: Context, id: Int, notification: android.app.Notification) {
    try {
      NotificationManagerCompat.from(context).notify(id, notification)
    } catch (_: SecurityException) {
      // POST_NOTIFICATIONS revoked since the toggle was turned on: nothing to show it with.
    }
  }

  private fun open(context: Context, requestCode: Int, uri: String): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri))
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun broadcast(context: Context, extras: Bundle, action: String, mutable: Boolean = false): PendingIntent {
    val intent = Intent(context, NotifyActionReceiver::class.java)
      .setAction("app.winnow.android.notify.$action")
      // Not the picture: up to tens of KB per button would weigh on the binder, and a
      // notification rebuilt after an action can do without it.
      .putExtras(Bundle(extras).apply { remove(EXTRA_PICTURE) })
      .putExtra(EXTRA_ACTION, action)
    // RemoteInput fills the reply into the intent, which needs a mutable PendingIntent
    // (Android 12+); everything else is immutable.
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE)
    return PendingIntent.getBroadcast(context, extras.getInt(EXTRA_NOTIFICATION_ID) * 31 + action.hashCode(), intent, flags)
  }

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL) != null) return
    val channel = NotificationChannel(CHANNEL, "New mail", NotificationManager.IMPORTANCE_HIGH)
    channel.description = "Mail that arrived since Winnow last checked"
    manager.createNotificationChannel(channel)
  }

  fun markAction(extras: Bundle, action: String): Bundle = Bundle(extras).apply { putString(EXTRA_ACTION_NAME, action) }
}

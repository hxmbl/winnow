package app.winnow.android.sync

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationManagerCompat

/**
 * "Instant mail via the Gmail app" (Settings → Notifications & sync, STRM-442): Winnow
 * piggybacks on the push the Gmail app already gets from Google. Winnow has no push
 * server of its own, but when the Gmail app posts a notification, new mail has just
 * arrived, so this checks straight away (Gmail's `history.list`, the same light check as
 * the fallback poll) instead of waiting for the next poll, and then takes the Gmail
 * app's copy down so only Winnow's notification shows.
 *
 * **Privacy.** A notification listener can see every app's notifications, which is why
 * Android makes the user grant "Notification access" by hand. This one looks at a
 * notification's package first and drops anything that is not the Gmail app
 * ([GmailListenerLogic.isGmail]) before reading any of it. Of Gmail's own it reads only
 * the account line (sub-text and summary), in memory, to pick the account to sync.
 * Nothing is stored, and the log says only how many accounts a check covered. It only
 * ever cancels the Gmail app's notifications, and only once Winnow has posted its own
 * for that mail ([GmailListenerLogic.keysToCancel]).
 *
 * **With the app closed.** Android binds a granted listener itself, Winnow running or
 * not. When [MailSyncService] is running the check goes through it ([MailSyncService.instant]);
 * when it is not, it runs here on the listener's own thread ([MailCheckRun]).
 *
 * **Off.** With the setting off (or background sync off) it ignores everything and asks
 * Android to unbind it; [BackgroundSyncPlugin.configure] asks for a rebind when the
 * setting comes back on.
 */
class GmailNotificationListener : NotificationListenerService() {
  private lateinit var thread: HandlerThread
  private lateinit var handler: Handler
  private val debounce = GmailListenerLogic.Debounce()
  private val fire = Runnable { deliver() }

  override fun onCreate() {
    super.onCreate()
    thread = HandlerThread("winnow-gmail-listener").apply { start() }
    handler = Handler(thread.looper)
  }

  override fun onDestroy() {
    connected = false
    handler.removeCallbacksAndMessages(null)
    thread.quitSafely()
    super.onDestroy()
  }

  override fun onListenerConnected() {
    super.onListenerConnected()
    val config = SyncStore(this).config()
    if (!config.enabled || !config.gmailListener) {
      connected = false
      try {
        requestUnbind()
      } catch (_: Exception) {
      }
      return
    }
    connected = true
    Log.i(TAG, "connected")
    MailSyncService.instance?.repace()
  }

  override fun onListenerDisconnected() {
    connected = false
    Log.i(TAG, "disconnected")
    MailSyncService.instance?.repace()
    super.onListenerDisconnected()
  }

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    // Another app's notification: not read, not logged, not touched.
    if (sbn == null || !GmailListenerLogic.isGmail(sbn.packageName)) return
    val config = SyncStore(this).config()
    if (!config.enabled || !config.gmailListener) return
    val notification = sbn.notification ?: return
    if (notification.flags and Notification.FLAG_ONGOING_EVENT != 0) return
    val extras = notification.extras
    val accounts = GmailListenerLogic.accountsFor(
      listOf(extras?.getCharSequence(Notification.EXTRA_SUB_TEXT), extras?.getCharSequence(Notification.EXTRA_SUMMARY_TEXT)),
      config.accounts,
    )
    val key = sbn.key
    handler.post {
      val wait = debounce.offer(accounts, key)
      if (wait != null) handler.postDelayed(fire, wait)
    }
  }

  /** The burst is over: one check for the accounts it named, then Gmail's copies down. */
  private fun deliver() {
    val request = debounce.take() ?: return
    check(request, retry = true)
  }

  private fun check(request: GmailListenerLogic.Request, retry: Boolean) {
    Log.i(TAG, "gmail notified: checking ${request.accounts?.size?.toString() ?: "all"} account(s)")
    val service = MailSyncService.instance
    if (service != null) {
      service.instant(request.accounts) { posted -> handler.post { afterCheck(request, posted, retry) } }
      return
    }
    val config = SyncStore(this).config()
    if (!config.enabled || !config.gmailListener) return
    val posted = try {
      MailCheckRun.run(this, config, request.accounts).posted
    } catch (e: Exception) {
      Log.w(TAG, "check failed", e)
      emptySet()
    }
    afterCheck(request, posted, retry)
    // Try to bring the service back for the fallback poll (Android may refuse from here).
    MailSyncService.apply(this)
  }

  private fun afterCheck(request: GmailListenerLogic.Request, posted: Set<String>, retry: Boolean) {
    cancelGmailCopies(request.gmailKeys, posted)
    if (retry && GmailListenerLogic.wantsRetry(request.gmailKeys, posted)) {
      val again = GmailListenerLogic.Request(GmailListenerLogic.retryAccounts(request.gmailKeys, posted), request.gmailKeys)
      handler.postDelayed({ check(again, retry = false) }, GmailListenerLogic.RETRY_MS)
    }
  }

  private fun cancelGmailCopies(keys: Map<String, Set<String>?>, posted: Set<String>) {
    if (keys.isEmpty() || posted.isEmpty()) return
    val active = try {
      activeNotifications?.filter { it.key in keys }?.associate { it.key to it.packageName } ?: return
    } catch (_: Exception) {
      return
    }
    val cancel = GmailListenerLogic.keysToCancel(keys, active, posted)
    for (key in cancel) {
      try {
        cancelNotification(key)
      } catch (_: Exception) {
      }
    }
    if (cancel.isNotEmpty()) Log.i(TAG, "took down ${cancel.size} Gmail notification(s)")
  }

  companion object {
    private const val TAG = "WinnowGmailListener"

    /** Android has this listener bound and the setting is on (the fallback poll slows to 10 minutes). */
    @Volatile var connected = false
      private set

    /** Whether the user has given Winnow notification access in Android's settings. */
    fun accessGranted(context: Context): Boolean =
      NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)

    /** Whether the Gmail app is installed (the manifest's `<queries>` makes it visible). */
    fun gmailInstalled(context: Context): Boolean =
      try {
        context.packageManager.getApplicationInfo(GmailListenerLogic.GMAIL_PACKAGE, 0).enabled
      } catch (_: Exception) {
        false
      }

    /** The setting came on (or the config changed with it on): ask Android to bind the listener again. */
    fun rebind(context: Context) {
      if (!accessGranted(context)) return
      try {
        requestRebind(ComponentName(context, GmailNotificationListener::class.java))
      } catch (_: Exception) {
      }
    }
  }
}

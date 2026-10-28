package app.winnow.android.notify

/**
 * The newest `winnow://` link [app.winnow.android.MainActivity] was opened with (a
 * notification's tap), kept until the web layer takes it.
 *
 * Why not leave it to the deep-link plugin alone: the plugin reads the launch intent
 * once, when it first loads, and hears later intents only once Rust has registered it.
 * The background sync service (`sync/MailSyncService.kt`) keeps Winnow's process alive
 * with no activity, so a tap on one of its notifications usually starts a *new* activity
 * in a process whose plugins loaded long ago: the plugin never sees that intent, and its
 * "current" link is whatever the last tap was, maybe yesterday's message. And after
 * Android killed the process, a tap recreates the activity and delivers the link as a
 * new intent before Rust is up to pass it on. So the activity keeps every link here too,
 * and the web layer takes it (`deep_link_launch` → `NotifyPlugin.launchLinks`) when its
 * page loads, and again after each link the plugin did deliver, so a link the plugin
 * already handed over is never opened a second time on the next page load (the web layer
 * drops the repeat).
 *
 * Only the newest link is kept (two taps before the app is ready mean the second), and
 * not for long ([MAX_AGE_MS]): a link nobody took in that time is not what the user is
 * waiting for any more. Pure Kotlin (no android.net.Uri), so the JVM tests can pin it.
 */
object LaunchLinks {
  /** `Intent.ACTION_VIEW`, and ChromeOS's variant of it. */
  const val ACTION_VIEW = "android.intent.action.VIEW"
  const val ARC_ACTION_VIEW = "org.chromium.arc.intent.action.VIEW"

  /** `Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`: reopened from Recents, not tapped now. */
  const val FLAG_LAUNCHED_FROM_HISTORY = 0x00100000

  /** Far longer than any link Winnow builds (`MailNotifier.messageUri`). */
  const val MAX_LENGTH = 512

  /** A cold start on a slow phone, sign-in restore included, is well inside this. */
  const val MAX_AGE_MS = 120_000L

  private var pending: String? = null
  private var pendingAt = 0L

  /** A link this app builds: `winnow://…`, short, and printable ASCII only. */
  fun isWinnowLink(url: String?): Boolean =
    url != null &&
      url.length <= MAX_LENGTH &&
      url.length > PREFIX.length &&
      url.startsWith(PREFIX) &&
      url.all { it.code in 0x21..0x7e }

  private const val PREFIX = "winnow://"

  private fun isView(action: String?) = action == ACTION_VIEW || action == ARC_ACTION_VIEW

  /**
   * The link an activity's `onCreate` should keep, or null. Not when Android is
   * recreating the activity (`restored`, after it killed the process) or reopening it
   * from Recents: either way the intent is the one from the original tap, and opening
   * that message again now would be a surprise. (A tap that recreates the activity
   * arrives as a new intent right after: [newIntentLink].)
   */
  fun launchLink(action: String?, url: String?, flags: Int, restored: Boolean): String? {
    if (restored) return null
    if (flags and FLAG_LAUNCHED_FROM_HISTORY != 0) return null
    if (!isView(action)) return null
    return url.takeIf { isWinnowLink(it) }
  }

  /** The link an activity's `onNewIntent` should keep, or null: a fresh tap every time. */
  fun newIntentLink(action: String?, url: String?): String? =
    if (isView(action)) url.takeIf { isWinnowLink(it) } else null

  /** `onCreate`'s intent (see [launchLink]); `false` if it carried nothing to keep. */
  fun offerLaunch(action: String?, url: String?, flags: Int, restored: Boolean, now: Long = System.currentTimeMillis()): Boolean =
    keep(launchLink(action, url, flags, restored), now)

  /** `onNewIntent`'s intent (see [newIntentLink]); `false` if it carried nothing to keep. */
  fun offerNew(action: String?, url: String?, now: Long = System.currentTimeMillis()): Boolean =
    keep(newIntentLink(action, url), now)

  @Synchronized
  private fun keep(link: String?, now: Long): Boolean {
    if (link == null) return false
    pending = link
    pendingAt = now
    return true
  }

  /** The kept link, at most once and only while it is fresh. */
  @Synchronized
  fun take(now: Long = System.currentTimeMillis()): List<String> {
    val link = pending ?: return emptyList()
    val age = now - pendingAt
    pending = null
    return if (age in 0..MAX_AGE_MS) listOf(link) else emptyList()
  }

  /** For tests. */
  @Synchronized
  fun clear() {
    pending = null
    pendingAt = 0L
  }
}

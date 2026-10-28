package app.winnow.android.sync

/**
 * The decisions behind "Instant mail via the Gmail app" ([GmailNotificationListener]), as
 * plain Kotlin with no Android in it, so the JVM tests cover them (`GmailListenerLogicTest`):
 *
 * - **Which notifications count.** Only the Gmail app's ([GMAIL_PACKAGE]). Anything else
 *   is dropped before a single field of it is read, and is never cancelled.
 * - **Which account to sync.** Gmail puts the account's address on its notifications
 *   (the sub-text line, or the summary of a bundle) when more than one account is signed
 *   in. A signed-in Winnow account whose address appears there is the one synced; when
 *   none does (one account, a Gmail version that says nothing, an account Winnow does
 *   not have), every account is.
 * - **Bursts.** Gmail posts several notifications for one arrival (the message, the
 *   bundle summary, an update a second later) and several at once after a gap.
 *   [Debounce] turns a burst into one sync.
 * - **The fallback poll's pace.** [pollInterval]: slower when the listener is doing the
 *   work, the old pace never.
 */
object GmailListenerLogic {
  /** The Gmail app. The only package whose notifications Winnow looks at. */
  const val GMAIL_PACKAGE = "com.google.android.gm"

  /** A burst of Gmail notifications within this window is one sync. */
  const val DEBOUNCE_MS = 2_000L

  /** The fallback poll while Gmail's notifications are telling Winnow about new mail. */
  const val POLL_WITH_LISTENER_MS = 10 * 60_000L

  /** The poll when they are not: the setting is off, or Android has not connected the listener. */
  const val POLL_WITHOUT_LISTENER_MS = 5 * 60_000L

  /** Whether a notification from `packageName` is one to act on. Nothing else is read. */
  fun isGmail(packageName: String?): Boolean = packageName == GMAIL_PACKAGE

  private val ADDRESS = Regex("[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")

  /** Addresses in the notification's account fields, lowercased. */
  fun addressesIn(fields: List<CharSequence?>): Set<String> {
    val out = HashSet<String>()
    for (field in fields) {
      if (field.isNullOrEmpty()) continue
      for (match in ADDRESS.findAll(field)) out.add(match.value.lowercase())
    }
    return out
  }

  /**
   * The accounts to sync for one Gmail notification: those whose address is among
   * `fields` (Gmail's sub-text and summary), or `null` for all of them when none matches.
   * Matched on [SyncAccount.address], which is set whatever the number of accounts.
   */
  fun accountsFor(fields: List<CharSequence?>, accounts: List<SyncAccount>): Set<String>? {
    val addresses = addressesIn(fields)
    if (addresses.isEmpty()) return null
    val matched = accounts.filter { account -> account.address?.let { it in addresses } == true }.map { it.id }.toSet()
    return matched.ifEmpty { null }
  }

  /**
   * The fallback poll's interval: every 10 minutes while the setting is on and Android
   * has the listener connected (Gmail's notifications bring new mail sooner), every 5
   * minutes otherwise.
   */
  fun pollInterval(listenerOn: Boolean, listenerConnected: Boolean): Long =
    if (listenerOn && listenerConnected) POLL_WITH_LISTENER_MS else POLL_WITHOUT_LISTENER_MS

  /**
   * One debounced request: which accounts to sync (`null`: all), and each of Gmail's
   * notification keys with the accounts it was matched to (`null`: no address matched).
   */
  data class Request(val accounts: Set<String>?, val gmailKeys: Map<String, Set<String>?>)

  /**
   * Gathers a burst of Gmail notifications into one sync. The first notification of a
   * burst opens a window of [windowMs]; everything that arrives inside it joins that
   * sync, and [take] hands the whole lot over once the window closes. Not thread-safe:
   * the listener calls it from one thread.
   */
  class Debounce(private val windowMs: Long = DEBOUNCE_MS) {
    private var waiting = false
    private var all = false
    private val accounts = HashSet<String>()
    private val keys = LinkedHashMap<String, Set<String>?>()

    /**
     * Add one notification. Answers how long to wait before calling [take] when this is
     * the first of a burst (the caller schedules that), or `null` when a sync is already
     * waiting and this one has joined it.
     */
    fun offer(forAccounts: Set<String>?, key: String?): Long? {
      if (forAccounts == null) all = true else accounts.addAll(forAccounts)
      if (key != null) keys[key] = forAccounts
      if (waiting) return null
      waiting = true
      return windowMs
    }

    /** Whether a sync is waiting. */
    fun pending(): Boolean = waiting

    /** The burst's sync, or `null` when nothing is waiting; the next [offer] starts a new burst. */
    fun take(): Request? {
      if (!waiting) return null
      val request = Request(if (all) null else accounts.toSet(), LinkedHashMap(keys))
      waiting = false
      all = false
      accounts.clear()
      keys.clear()
      return request
    }
  }

  /**
   * Which of Gmail's notifications may be taken down after a sync, so only Winnow's
   * shows. A key goes only when all of this holds:
   * - it is still showing and still the Gmail app's (`active` maps a showing key to its
   *   package), so another app's notification is never touched;
   * - its address matched a Winnow account, so mail for a Gmail account Winnow doesn't
   *   have keeps its Gmail notification;
   * - Winnow posted new mail for every account it matched (`posted`: checked without
   *   trouble, new mail found, the account's notifications on). A failed check, an
   *   account with Winnow's notifications off, or a check that found nothing yet leaves
   *   Gmail's copy up, so the user is never left with no notification at all.
   */
  fun keysToCancel(requested: Map<String, Set<String>?>, active: Map<String, String>, posted: Set<String>): List<String> =
    requested.filter { (key, matched) -> isGmail(active[key]) && covered(matched, posted) }.keys.toList()

  /**
   * Whether to check once more before giving up on taking Gmail's copies down: some key
   * matched an account for which nothing was posted (Gmail can notify a moment before
   * `history.list` shows the message). One retry, after [RETRY_MS]; then Gmail's stay.
   */
  fun wantsRetry(requested: Map<String, Set<String>?>, posted: Set<String>): Boolean =
    requested.values.any { matched -> !matched.isNullOrEmpty() && !covered(matched, posted) }

  /** The accounts a retry checks: those matched by a key that is not covered yet. */
  fun retryAccounts(requested: Map<String, Set<String>?>, posted: Set<String>): Set<String> =
    requested.values.filterNotNull().filter { !covered(it, posted) }.flatten().filter { it !in posted }.toSet()

  /** How long after the first sync the one retry runs. */
  const val RETRY_MS = 20_000L

  private fun covered(matched: Set<String>?, posted: Set<String>): Boolean = !matched.isNullOrEmpty() && matched.all { it in posted }
}

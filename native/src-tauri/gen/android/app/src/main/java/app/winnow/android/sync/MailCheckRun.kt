package app.winnow.android.sync

import android.content.Context
import app.winnow.android.notify.MailNotifier

/**
 * One background check of some or all accounts: `history.list` per account
 * ([GmailCheck]), new-mail notifications posted, stale ones taken down, cursors moved.
 *
 * Shared by the two things that start a check with the app closed: [MailSyncService]'s
 * fallback poll, and [GmailNotificationListener] when the Gmail app posts a notification
 * (through the service when it is running, on the listener's own thread when it is
 * not). Runs are serialised on one lock, so the two can never read the same cursor at
 * once and announce a message twice.
 */
object MailCheckRun {
  /**
   * What a run found.
   * - `failed`: some account could not be checked (offline, an error), for the backoff.
   * - `needSignIn`: accounts Google refused, for the persistent notification.
   * - `posted`: accounts checked without trouble that had new mail and notify, so their
   *   new mail is on a Winnow notification now (what lets Gmail's copy be taken down).
   */
  data class Outcome(val failed: Boolean, val needSignIn: List<String>, val posted: Set<String>)

  private val lock = Any()

  /** Check `only` those accounts, or every account when `null`. Blocks; never on the main thread. */
  fun run(context: Context, config: BackgroundConfig, only: Set<String>?): Outcome = synchronized(lock) {
    val store = SyncStore(context)
    val keyring = KeyringReader(context)
    val client = keyring.get(KeyringFormat.CLIENT_NAME)
    var failed = false
    val signIn = ArrayList<String>()
    val posted = HashSet<String>()
    for (account in config.accounts) {
      if (store.signedOut(account.id)) {
        signIn.add(account.label ?: account.id)
        continue
      }
      if (only != null && account.id !in only) continue
      val result = GmailCheck.run(
        account = account.id,
        tokensRaw = keyring.get(KeyringFormat.tokensName(account.id)),
        clientRaw = client,
        cursor = store.cursor(account.id),
        cached = TokenMemory.get(account.id),
        now = System.currentTimeMillis(),
        transport = HttpsTransport,
        cache = TokenMemory,
        quietSenders = config.quietSenders,
      )
      when (result) {
        is GmailCheck.Result.Seeded -> store.setCursor(account.id, result.cursor)
        is GmailCheck.Result.Checked -> {
          if (result.stale.isNotEmpty()) MailNotifier.dismiss(context, account.id, result.stale)
          if (result.fresh.isNotEmpty() && config.notifies(account.id)) {
            announce(context, config, account.id, result.fresh)
            posted.add(account.id)
          }
          // The cursor moves only once what it covers has been announced.
          store.setCursor(account.id, result.cursor)
        }
        GmailCheck.Result.SignedOut -> {
          store.setSignedOut(account.id, true)
          signIn.add(account.label ?: account.id)
        }
        GmailCheck.Result.Offline -> failed = true
        is GmailCheck.Result.Failed -> failed = true
      }
    }
    Outcome(failed, signIn, posted)
  }

  private fun announce(context: Context, config: BackgroundConfig, account: String, fresh: List<GmailCheck.Message>) {
    val notices = fresh.map {
      MailNotifier.BackgroundNotice(
        gmailId = it.gmailId,
        threadId = it.threadId,
        title = it.senderName,
        subject = it.subject,
        preview = it.snippet.take(140),
        receivedAt = it.receivedAt,
      )
    }
    MailNotifier.showFromBackground(context, account, config.labelFor(account), config.actions, config.hidePreview, notices)
  }
}

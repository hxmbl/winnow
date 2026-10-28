package app.winnow.android.sync

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ProcessLifecycleOwner
import app.winnow.android.R
import app.winnow.android.notify.MailNotifier

/**
 * Background sync on Android, the FairEmail way: a foreground service with a silent,
 * low-importance notification keeps Winnow's process alive after the app is closed or
 * swiped away, and checks every signed-in account for new mail about once a minute
 * ([GmailCheck], Gmail's `history.list`), posting the same new-mail notifications the app
 * posts and taking down the ones whose mail no longer needs attention.
 *
 * **Why not the WebView.** Android pauses a backgrounded WebView and destroys it with the
 * activity, so the web layer cannot be the one checking. The service does the check
 * itself, in Kotlin, with no Rust and no WebView: it can be started by Android on boot or
 * after the process was killed, when neither exists. It reads the tokens the web layer
 * stored ([KeyringReader]) and refreshes access tokens itself, in memory.
 *
 * **While the app is on screen** it does nothing but wait: the web layer syncs every few
 * seconds and posts its own notifications. Either side records what it announced
 * ([app.winnow.android.notify.NoticeLedger]), so a message is announced once.
 *
 * **Type `specialUse`** (Android 14+), as FairEmail does, with the manifest's
 * `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`: `dataSync` would fit the words, but Android 15 caps
 * it at 6 hours a day and refuses to start it from `BOOT_COMPLETED`; `specialUse` has
 * neither limit. Winnow is not on Google Play, so the Play declaration does not apply.
 *
 * **Idle phones.** A Handler does the minute-by-minute pacing while the phone is awake;
 * an allow-while-idle alarm is the backstop in Doze, where Android spaces wake-ups out
 * (roughly every 9 minutes or more) whatever an app asks. The network coming back and
 * the screen turning on both check straight away. Exempting Winnow from battery
 * optimisation (offered in Settings) keeps the network available in Doze.
 */
class MailSyncService : Service() {
  private lateinit var thread: HandlerThread
  private lateinit var worker: Handler
  private val main = Handler(Looper.getMainLooper())
  private val check = Runnable { runCheck() }

  /** The app is on screen: the web layer is syncing and notifying itself. */
  @Volatile private var appVisible = false
  private var failures = 0
  @Volatile private var lastCheck = 0L
  private var trouble: List<String> = emptyList()
  private var started = false

  private var network: ConnectivityManager.NetworkCallback? = null
  private val screenOn = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (SystemClock.elapsedRealtime() - lastCheck > SCREEN_ON_GAP_MS) schedule(0)
    }
  }
  private val lifecycle = LifecycleEventObserver { _, event ->
    when (event) {
      Lifecycle.Event.ON_START -> appVisible = true
      // Closed or sent to the background: catch up shortly, then every minute.
      Lifecycle.Event.ON_STOP -> {
        appVisible = false
        schedule(AFTER_APP_CLOSED_MS)
      }
      else -> Unit
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    thread = HandlerThread("winnow-sync").apply { start() }
    worker = Handler(thread.looper)
    ensureChannel(this)
    ProcessLifecycleOwner.get().lifecycle.let {
      appVisible = it.currentState.isAtLeast(Lifecycle.State.STARTED)
      it.addObserver(lifecycle)
    }
    registerReceiver(screenOn, IntentFilter(Intent.ACTION_SCREEN_ON))
    val connectivity = getSystemService(ConnectivityManager::class.java)
    if (connectivity != null) {
      val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(n: Network) {
          if (failures > 0) schedule(NETWORK_BACK_MS)
        }
      }
      try {
        connectivity.registerDefaultNetworkCallback(callback)
        network = callback
      } catch (_: Exception) {
      }
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Within five seconds of startForegroundService, whatever happens next.
    goForeground()
    val config = SyncStore(this).config()
    if (!config.enabled) {
      stop()
      return START_NOT_STICKY
    }
    if (!started || intent?.action == ACTION_CHECK) {
      started = true
      schedule(if (intent?.action == ACTION_CHECK) 0 else FIRST_CHECK_MS)
    }
    // Android restarts the service (with a null intent) if it has to kill the process.
    return START_STICKY
  }

  /** Swiped out of Recents: the service and its process carry on. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    appVisible = false
    schedule(AFTER_APP_CLOSED_MS)
  }

  override fun onDestroy() {
    worker.removeCallbacksAndMessages(null)
    cancelAlarm()
    try {
      unregisterReceiver(screenOn)
    } catch (_: Exception) {
    }
    network?.let { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it) }
    ProcessLifecycleOwner.get().lifecycle.removeObserver(lifecycle)
    thread.quitSafely()
    super.onDestroy()
  }

  private fun stop() {
    worker.removeCallbacksAndMessages(null)
    cancelAlarm()
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  // ── The loop ────────────────────────────────────────────────────────────

  private fun schedule(delayMs: Long) {
    if (!::worker.isInitialized) return
    worker.removeCallbacks(check)
    worker.postDelayed(check, delayMs)
    // The backstop: a Handler does not run while the phone sleeps.
    setAlarm(maxOf(delayMs, GmailCheck.INTERVAL_MS) + ALARM_SLACK_MS)
  }

  @SuppressLint("WakelockTimeout")
  private fun runCheck() {
    val store = SyncStore(this)
    val config = store.config()
    if (!config.enabled) {
      main.post { stop() }
      return
    }
    if (appVisible) {
      schedule(GmailCheck.INTERVAL_MS)
      return
    }
    val power = getSystemService(PowerManager::class.java)
    val lock = power?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "winnow:sync")?.apply { acquire(WAKE_MS) }
    try {
      lastCheck = SystemClock.elapsedRealtime()
      val keyring = KeyringReader(this)
      val client = keyring.get(KeyringFormat.CLIENT_NAME)
      var failed = false
      val signIn = ArrayList<String>()
      for (account in config.accounts) {
        if (store.signedOut(account.id)) {
          signIn.add(account.label ?: account.id)
          continue
        }
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
            if (result.stale.isNotEmpty()) MailNotifier.dismiss(this, account.id, result.stale)
            if (result.fresh.isNotEmpty() && config.notifies(account.id)) announce(config, account.id, result.fresh)
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
      failures = if (failed) failures + 1 else 0
      if (signIn != trouble) {
        trouble = signIn
        main.post { goForeground() }
      }
    } catch (e: Exception) {
      Log.w(TAG, "background check failed", e)
      failures += 1
    } finally {
      if (lock?.isHeld == true) lock.release()
    }
    schedule(GmailCheck.delayAfter(failures))
  }

  private fun announce(config: BackgroundConfig, account: String, fresh: List<GmailCheck.Message>) {
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
    MailNotifier.showFromBackground(this, account, config.labelFor(account), config.actions, config.hidePreview, notices)
  }

  // ── The persistent notification ─────────────────────────────────────────

  private fun goForeground() {
    val open = PendingIntent.getActivity(
      this,
      NOTIFICATION_ID,
      Intent(Intent.ACTION_VIEW, Uri.parse("winnow://open")).setPackage(packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val text = SyncText.persistent(trouble)
    val builder = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_winnow)
      .setContentTitle(text.first)
      .setContentText(text.second)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text.second))
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setVisibility(NotificationCompat.VISIBILITY_SECRET)
      .setOngoing(true)
      .setSilent(true)
      .setShowWhen(false)
      .setContentIntent(open)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
    // Straight to this channel's system settings, where it can be switched off while sync carries on.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val hide = PendingIntent.getActivity(
        this,
        NOTIFICATION_ID + 1,
        channelSettings(this),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      builder.addAction(0, "Hide this notification", hide)
    }
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, builder.build(), SyncText.serviceType(Build.VERSION.SDK_INT))
    } catch (e: Exception) {
      // Android refused (a background start without an exemption): nothing to keep alive.
      Log.w(TAG, "could not start in the foreground", e)
      stopSelf()
    }
  }

  // ── Alarms ──────────────────────────────────────────────────────────────

  private fun alarmIntent(): PendingIntent {
    val intent = Intent(this, MailSyncService::class.java).setAction(ACTION_CHECK)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      PendingIntent.getForegroundService(this, ALARM_REQUEST, intent, flags)
    } else {
      PendingIntent.getService(this, ALARM_REQUEST, intent, flags)
    }
  }

  private fun setAlarm(delayMs: Long) {
    val alarms = getSystemService(AlarmManager::class.java) ?: return
    try {
      alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + delayMs, alarmIntent())
    } catch (_: Exception) {
    }
  }

  private fun cancelAlarm() {
    getSystemService(AlarmManager::class.java)?.cancel(alarmIntent())
  }

  companion object {
    private const val TAG = "WinnowSync"
    const val CHANNEL = "winnow.sync"
    const val NOTIFICATION_ID = 0x5718
    const val ACTION_CHECK = "app.winnow.android.sync.CHECK"
    private const val ALARM_REQUEST = 0x5719

    private const val FIRST_CHECK_MS = 3_000L
    private const val AFTER_APP_CLOSED_MS = 5_000L
    private const val NETWORK_BACK_MS = 3_000L
    private const val SCREEN_ON_GAP_MS = 30_000L
    private const val ALARM_SLACK_MS = 15_000L
    private const val WAKE_MS = 60_000L

    /** Start or stop the service to match the saved config. Safe to call from anywhere it may start. */
    fun apply(context: Context) {
      val config = SyncStore(context).config()
      val intent = Intent(context, MailSyncService::class.java)
      if (!config.enabled) {
        context.stopService(intent)
        return
      }
      try {
        ContextCompat.startForegroundService(context, intent)
      } catch (e: Exception) {
        // ForegroundServiceStartNotAllowedException (Android 12+): started from the
        // background with no exemption. The next app launch or boot starts it.
        Log.w(TAG, "could not start background sync", e)
      }
    }

    /** Whether it is running now (best effort; for Settings). */
    @Suppress("DEPRECATION")
    fun running(context: Context): Boolean {
      val manager = context.getSystemService(android.app.ActivityManager::class.java) ?: return false
      return try {
        manager.getRunningServices(Int.MAX_VALUE).any { it.service.className == MailSyncService::class.java.name && it.foreground }
      } catch (_: Exception) {
        false
      }
    }

    fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      if (manager.getNotificationChannel(CHANNEL) != null) return
      // Low importance and silent: no sound, no peek, no status-bar icon. Its own channel,
      // so switching it off in system settings hides it without touching new-mail ones.
      val channel = NotificationChannel(CHANNEL, "Background sync", NotificationManager.IMPORTANCE_MIN)
      channel.description = "Shown while Winnow checks for new mail with the app closed. You can turn this off; checking carries on."
      channel.setShowBadge(false)
      channel.setSound(null, null)
      channel.enableVibration(false)
      manager.createNotificationChannel(channel)
    }

    /** The persistent notification's channel settings (or the app's, before Android 8). */
    fun channelSettings(context: Context): Intent =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
          .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }

    /** Whether the new-mail channel can show anything at all (permission and app switch). */
    fun notificationsAllowed(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()
  }
}

package app.winnow.android.signin

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.winnow.android.R

/**
 * Keeps Winnow running while the user is at Google in the sign-in Custom Tab.
 *
 * The browser sign-in redirects to a small HTTP listener inside Winnow on 127.0.0.1
 * (`src/oauth.rs`). With the Custom Tab in front, Winnow has no visible activity, and
 * recent Android (the cached-apps freezer, on by default from Android 14) freezes such
 * a process a few seconds later. A frozen process cannot accept a connection: the
 * redirect sits unanswered in the socket's queue and the browser shows "127.0.0.1 took
 * too long to respond". A foreground service makes the process ineligible for
 * freezing for as long as it runs.
 *
 * Type `shortService` (Android 14+): meant for exactly this, a few minutes of work
 * the user started, with no extra permission and no Play policy declaration. Android
 * ends it after about three minutes ([onTimeout]); a sign-in that takes longer loses
 * the protection, and the 5-minute wait in the app still applies. Older versions,
 * where the freezer is off by default, get a plain foreground service with no type.
 *
 * Started from the sign-in plugin's `openTab` (while the activity is in front, which a
 * foreground service start requires) and stopped by `endKeepAlive` once the redirect
 * arrives, the wait times out, or the user cancels; [MAX_MS] is the backstop.
 */
class SignInKeepAliveService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val backstop = Runnable { finish("backstop") }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      ensureChannel(this)
      val notification = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_winnow)
        .setContentTitle("Signing in to Winnow")
        .setContentText("Finish at Google, then come back to Winnow.")
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setOngoing(true)
        .setSilent(true)
        .build()
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        notification,
        SignInLogic.keepAliveServiceType(Build.VERSION.SDK_INT)
      )
      state = "running"
      handler.removeCallbacks(backstop)
      handler.postDelayed(backstop, MAX_MS)
    } catch (e: Exception) {
      // ForegroundServiceStartNotAllowedException and friends: the sign-in goes on
      // without the protection, as it did before.
      Log.w(TAG, "could not keep the app running for sign-in", e)
      state = "refused:${e.javaClass.simpleName}"
      stopSelf()
    }
    return START_NOT_STICKY
  }

  /** Android 14: a `shortService` ran out of time. It must stop now or the app ANRs. */
  override fun onTimeout(startId: Int) {
    finish("timeout")
  }

  /** Android 15 calls this overload instead. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    finish("timeout")
  }

  override fun onDestroy() {
    handler.removeCallbacks(backstop)
    if (state == "running") state = "stopped"
    super.onDestroy()
  }

  private fun finish(why: String) {
    state = why
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  companion object {
    private const val TAG = "WinnowSignIn"
    private const val CHANNEL = "sign-in"
    private const val NOTIFICATION_ID = 0x5167
    /** Longer than a `shortService` may run anyway; the backstop for older Android. */
    private const val MAX_MS = 5L * 60_000L

    /**
     * What happened to the last keep-alive, for the debug log: `starting`, `running`,
     * `stopped`, `timeout`, `backstop` or `refused:<exception>`.
     */
    @Volatile
    var state: String = "idle"
      private set

    /** Start it. False when Android refused outright (the tab opens anyway). */
    fun start(context: Context): Boolean = try {
      state = "starting"
      ContextCompat.startForegroundService(context, Intent(context, SignInKeepAliveService::class.java))
      true
    } catch (e: Exception) {
      Log.w(TAG, "could not start the sign-in keep-alive", e)
      state = "refused:${e.javaClass.simpleName}"
      false
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, SignInKeepAliveService::class.java))
    }

    private fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java) ?: return
      if (manager.getNotificationChannel(CHANNEL) != null) return
      val channel = NotificationChannel(CHANNEL, "Signing in", NotificationManager.IMPORTANCE_LOW)
      channel.description = "Shown while you finish signing in at Google"
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }
  }
}

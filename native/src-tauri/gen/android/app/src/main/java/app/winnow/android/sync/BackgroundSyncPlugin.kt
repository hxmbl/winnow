package app.winnow.android.sync

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * The web layer's handle on background sync, for `src/background_service.rs`
 * (registered there as `winnow-bgsync`).
 *
 * - `configure`: save the [BackgroundConfig] and start or stop [MailSyncService] to match.
 *   Called by the web layer whenever the switch, notifications, accounts or muted
 *   senders change, while the app is in front (where starting a foreground service is
 *   allowed).
 * - `status`: running, battery optimisation, notification permission, and the Gmail-app
 *   listener (access granted, connected, Gmail installed), for Settings.
 * - `requestBatteryExemption`: Android's own "Let Winnow run in the background?" dialog.
 * - `openSyncNotificationSettings`: the persistent notification's channel, to hide it.
 * - `openNotificationAccess`: Android's Notification access screen, for "Instant mail via
 *   the Gmail app" ([GmailNotificationListener]).
 *
 * Not granted to the webview directly: Rust calls these from its commands.
 */
@TauriPlugin
class BackgroundSyncPlugin(private val activity: Activity) : Plugin(activity) {
  private val context = activity.applicationContext

  @Command
  fun configure(invoke: Invoke) {
    try {
      val config = BackgroundConfig.fromJson(invoke.getArgs().optJSONObject("config"))
      val store = SyncStore(context)
      store.saveConfig(config)
      // A new config is the web layer's word that sign-in is fine again (it reconfigures
      // after every sign-in), so an account flagged "sign in again" is tried once more.
      store.clearSignedOut()
      TokenMemory.clear()
      MailSyncService.apply(context)
      // "Instant mail via the Gmail app": have Android bind the listener again (it unbinds
      // itself while the setting is off), and let the poll pick its pace.
      if (config.gmailListener) GmailNotificationListener.rebind(context)
      MailSyncService.instance?.repace()
      invoke.resolve(currentStatus())
    } catch (e: Exception) {
      invoke.reject(e.message ?: "could not configure background sync")
    }
  }

  @Command
  fun status(invoke: Invoke) {
    invoke.resolve(currentStatus())
  }

  @Command
  fun requestBatteryExemption(invoke: Invoke) {
    val power = context.getSystemService(PowerManager::class.java)
    if (power == null || power.isIgnoringBatteryOptimizations(context.packageName)) {
      invoke.resolve(currentStatus())
      return
    }
    // The direct dialog (REQUEST_IGNORE_BATTERY_OPTIMIZATIONS); the full list as a fallback
    // on builds that do not offer it.
    val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
    try {
      activity.startActivity(direct)
    } catch (_: Exception) {
      try {
        activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
      } catch (_: Exception) {
      }
    }
    invoke.resolve(currentStatus())
  }

  @Command
  fun openSyncNotificationSettings(invoke: Invoke) {
    MailSyncService.ensureChannel(context)
    try {
      activity.startActivity(MailSyncService.channelSettings(context))
    } catch (_: Exception) {
    }
    invoke.resolve()
  }

  /** Android's Notification access screen, where the user lets Winnow see the Gmail app's notifications. */
  @Command
  fun openNotificationAccess(invoke: Invoke) {
    try {
      activity.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    } catch (_: Exception) {
      try {
        activity.startActivity(Intent(Settings.ACTION_SETTINGS))
      } catch (_: Exception) {
      }
    }
    invoke.resolve(currentStatus())
  }

  private fun currentStatus(): JSObject {
    val power = context.getSystemService(PowerManager::class.java)
    val out = JSObject()
    out.put("enabled", SyncStore(context).config().enabled)
    out.put("running", MailSyncService.running(context))
    out.put("batteryUnrestricted", power?.isIgnoringBatteryOptimizations(context.packageName) ?: true)
    out.put("notificationsAllowed", MailSyncService.notificationsAllowed(context))
    out.put("sdk", Build.VERSION.SDK_INT)
    out.put("listenerAccess", GmailNotificationListener.accessGranted(context))
    out.put("listenerConnected", GmailNotificationListener.connected)
    out.put("gmailInstalled", GmailNotificationListener.gmailInstalled(context))
    return out
  }
}

/**
 * Start background sync again after a reboot or an app update, if it was on. Both
 * broadcasts are exemptions from Android 12's ban on starting foreground services from
 * the background, and Android 15's boot restriction does not cover `specialUse`.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> MailSyncService.apply(context)
    }
  }
}

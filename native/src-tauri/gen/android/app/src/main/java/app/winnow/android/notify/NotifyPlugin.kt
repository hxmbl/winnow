package app.winnow.android.notify

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.Executors

@InvokeArg
class EventHandlerArgs {
  lateinit var handler: Channel
}

/**
 * Actionable new-mail notifications, for `src/notify_actions/android.rs` (registered
 * there as `winnow-notify`).
 *
 * - `setEventHandler`: the channel [NotifyActionReceiver] reports button presses on.
 *   Rust decides what each press does (`plan.rs`).
 * - `show`: post a batch (one MessagingStyle notification per message, a group summary).
 * - `http`: one HTTPS exchange for Rust, which has no TLS client. Google's two API
 *   hosts only ([Http.ALLOWED_HOSTS]).
 * - `finish`: what the notification says once an action is done.
 * - `keptReplies` / `releaseKept`: replies kept on the device because they could not be
 *   sent or saved, listed for the web layer and released once it has saved them.
 *
 * None of these is granted to the webview (no `winnow-notify:` permission exists in
 * the capabilities), so only Rust can call them: `http` in particular must never be
 * reachable from page script.
 */
@TauriPlugin
class NotifyPlugin(private val activity: Activity) : Plugin(activity) {
  private val context = activity.applicationContext

  @Command
  fun setEventHandler(invoke: Invoke) {
    val args = invoke.parseArgs(EventHandlerArgs::class.java)
    handler = args.handler
    invoke.resolve()
  }

  @Command
  fun show(invoke: Invoke) {
    try {
      MailNotifier.show(context, invoke.getArgs())
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: "could not show the notification")
    }
  }

  @Command
  fun http(invoke: Invoke) {
    val args = invoke.getArgs()
    // Off the main thread: Rust is blocked on this answer, Android is not.
    io.execute { invoke.resolve(Http.exchange(args)) }
  }

  @Command
  fun finish(invoke: Invoke) {
    MailNotifier.finish(context, invoke.getArgs())
    invoke.resolve()
  }

  @Command
  fun keptReplies(invoke: Invoke) {
    val result = JSObject()
    result.put("items", PendingReplies.all(context))
    invoke.resolve(result)
  }

  @Command
  fun releaseKept(invoke: Invoke) {
    val ids = invoke.getArgs().optJSONArray("ids")
    if (ids != null) {
      for (i in 0 until ids.length()) PendingReplies.remove(context, ids.optString(i))
    }
    invoke.resolve()
  }

  companion object {
    /** Set once Rust has registered; null in a process Android restarted for a receiver. */
    @Volatile
    var handler: Channel? = null

    private val io = Executors.newCachedThreadPool()
  }
}

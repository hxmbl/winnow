package app.winnow.android.update

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

@InvokeArg
class InstallApkArgs {
  var url: String = ""
  var name: String = ""
}

/**
 * Self-update on Android, for `src/updater.rs` (registered there as `winnow-update`).
 *
 * `installApk` downloads a release's universal APK into the app's cache and hands it to
 * Android's package installer through the app's FileProvider. Android shows its own
 * "Do you want to update this app?" sheet; nothing installs without the user's tap.
 * The APK must be signed with the same key as the running app, or Android refuses it:
 * the web layer never offers a `-debug` APK for that reason.
 *
 * Android 8+ asks the user once to allow "Install unknown apps" for Winnow. When that
 * is off, the command opens that settings page and resolves `needs-permission`; the
 * web layer says to press Update again after allowing it.
 *
 * Resolves `{ kind: "opened" }`, `{ kind: "needs-permission" }` or rejects with a reason.
 */
@TauriPlugin
class UpdatePlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun installApk(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(InstallApkArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("unreadable arguments")
      return
    }
    if (!UpdateLogic.isReleaseApk(args.url, args.name)) {
      invoke.reject("not a Winnow release APK")
      return
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      !activity.packageManager.canRequestPackageInstalls()
    ) {
      try {
        activity.startActivity(
          Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${activity.packageName}")
          )
        )
      } catch (e: ActivityNotFoundException) {
        // A phone without the page: the installer itself will ask instead.
      }
      val result = JSObject()
      result.put("kind", "needs-permission")
      invoke.resolve(result)
      return
    }

    Thread {
      try {
        val dir = File(activity.cacheDir, "updates")
        dir.mkdirs()
        // One update at a time: old downloads are only clutter.
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, args.name)
        download(args.url, file)
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.runOnUiThread {
          try {
            activity.startActivity(intent)
            val result = JSObject()
            result.put("kind", "opened")
            invoke.resolve(result)
          } catch (e: Exception) {
            invoke.reject("the package installer could not be opened: ${e.message}")
          }
        }
      } catch (e: Exception) {
        invoke.reject("the download failed: ${e.message}")
      }
    }.start()
  }

  private fun download(from: String, to: File) {
    var url = URL(from)
    // GitHub answers a release download with a redirect to its file host; follow a few,
    // https only (HttpURLConnection already refuses to cross from https to http).
    repeat(5) {
      val connection = url.openConnection() as HttpURLConnection
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 20_000
      connection.readTimeout = 60_000
      try {
        val code = connection.responseCode
        if (code in 300..399) {
          val next = connection.getHeaderField("Location") ?: throw IllegalStateException("redirect without a location")
          url = URL(url, next)
          if (url.protocol != "https") throw IllegalStateException("refusing a non-https redirect")
          return@repeat
        }
        if (code != 200) throw IllegalStateException("HTTP $code")
        val length = connection.contentLengthLong
        if (length > UpdateLogic.MAX_APK_BYTES) throw IllegalStateException("the file is too large")
        val partial = File(to.parentFile, "${to.name}.part")
        var total = 0L
        connection.inputStream.use { input ->
          partial.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              total += read
              if (total > UpdateLogic.MAX_APK_BYTES) throw IllegalStateException("the file is too large")
              output.write(buffer, 0, read)
            }
          }
        }
        if (!partial.renameTo(to)) throw IllegalStateException("could not save the download")
        return
      } finally {
        connection.disconnect()
      }
    }
    throw IllegalStateException("too many redirects")
  }
}

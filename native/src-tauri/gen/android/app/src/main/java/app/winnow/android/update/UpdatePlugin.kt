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
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

@InvokeArg
class InstallApkArgs {
  var url: String = ""
  var name: String = ""
  /** The offer came from Dev Options → Beta updates: a pre-release's APK is allowed. */
  var beta: Boolean = false
  /**
   * Where each stage is reported as it begins (`updater::UpdateProgress` in Rust, read by
   * `parseProgress` in the web layer): `downloading` with bytes so far and the size when
   * the server gives one, `verifying`, `installing`. Absent from an older web layer.
   */
  var onProgress: Channel? = null
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
 * Before the installer opens, the APK is checked against the release's `SHA256SUMS`:
 * a release without one, or a download that doesn't match it, is refused and deleted.
 *
 * Each stage is reported on `onProgress` as it begins, so the app can say what it is
 * doing: downloading (with progress), verifying, opening the installer.
 *
 * Android 8+ asks the user once to allow "Install unknown apps" for Winnow. When that
 * is off, the command opens that settings page and resolves `needs-permission`; the
 * web layer says to press Update again after allowing it.
 *
 * Resolves `{ kind: "opened" }`, `{ kind: "needs-permission" }` or rejects with a reason.
 */
/** A download that was fetched but must not be installed; its message is the reason. */
private class Refused(message: String) : Exception(message)

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
    if (UpdateLogic.isPrereleaseDownload(args.url) && !args.beta) {
      invoke.reject(UpdateLogic.PRERELEASE_REFUSED)
      return
    }
    if (!UpdateLogic.isReleaseApk(args.url, args.name, allowPrerelease = args.beta)) {
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

    val progress = args.onProgress
    Thread {
      try {
        val dir = File(activity.cacheDir, "updates")
        dir.mkdirs()
        // One update at a time: old downloads are only clutter.
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, args.name)
        report(progress, "downloading", 0L, null)
        var lastReported = -1L
        download(args.url, file, UpdateLogic.MAX_APK_BYTES) { received, length ->
          if (UpdateLogic.worthReporting(lastReported, received, length)) {
            lastReported = received
            report(progress, "downloading", received, length)
          }
        }
        // Checked before anything opens it: the release's own list of checksums.
        report(progress, "verifying")
        val sumsFile = File(dir, UpdateLogic.SUMS_NAME)
        try {
          download(UpdateLogic.sumsUrl(args.url), sumsFile, UpdateLogic.MAX_SUMS_BYTES)
        } catch (e: Exception) {
          throw Refused("couldn't check the download: this release has no checksums (${e.message})")
        }
        val expected = UpdateLogic.expectedSha256(sumsFile.readText(), args.name)
        sumsFile.delete()
        if (expected == null) {
          throw Refused("couldn't check the download: the release lists no checksum for ${args.name}")
        }
        if (sha256(file) != expected) {
          throw Refused("the download doesn't match the release's checksum, so it wasn't installed")
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        report(progress, "installing")
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
      } catch (e: Refused) {
        // Nothing unchecked is left lying in the cache.
        File(activity.cacheDir, "updates").listFiles()?.forEach { it.delete() }
        invoke.reject(e.message ?: "the download couldn't be checked")
      } catch (e: Exception) {
        invoke.reject("the download failed: ${e.message}")
      }
    }.start()
  }

  /** One stage report on the web layer's channel; a report that can't be sent is dropped. */
  private fun report(channel: Channel?, stage: String, received: Long? = null, total: Long? = null) {
    if (channel == null) return
    try {
      val message = JSObject()
      message.put("stage", stage)
      if (received != null) message.put("received", received)
      if (total != null && total > 0) message.put("total", total)
      channel.send(message)
    } catch (e: Exception) {
      // The webview went away: the install goes on without its reports.
    }
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  /** `onChunk(received, total)` after each read; `total` is null when the server gives no size. */
  private fun download(from: String, to: File, maxBytes: Long, onChunk: (Long, Long?) -> Unit = { _, _ -> }) {
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
        if (length > maxBytes) throw IllegalStateException("the file is too large")
        val partial = File(to.parentFile, "${to.name}.part")
        var total = 0L
        connection.inputStream.use { input ->
          partial.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              val read = input.read(buffer)
              if (read < 0) break
              total += read
              if (total > maxBytes) throw IllegalStateException("the file is too large")
              output.write(buffer, 0, read)
              onChunk(total, if (length > 0) length else null)
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

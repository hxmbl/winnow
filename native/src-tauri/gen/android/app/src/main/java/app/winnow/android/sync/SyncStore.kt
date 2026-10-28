package app.winnow.android.sync

import android.content.Context
import app.winnow.android.notify.Http
import java.io.IOException
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

/**
 * The background check's own state, in the app's private preferences: the web layer's
 * [BackgroundConfig], and each account's history cursor and sign-in trouble. Not a cache
 * of mail: nothing about a message is kept here.
 */
class SyncStore(context: Context) {
  private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  fun config(): BackgroundConfig =
    try {
      BackgroundConfig.fromJson(prefs.getString(KEY_CONFIG, null)?.let { JSONObject(it) })
    } catch (_: Exception) {
      BackgroundConfig.OFF
    }

  /**
   * Save a new config. Cursors of accounts that are gone are forgotten, so an account
   * signed in again starts from "now" rather than announcing a week of mail.
   */
  fun saveConfig(config: BackgroundConfig) {
    val editor = prefs.edit().putString(KEY_CONFIG, config.toJson().toString())
    val ids = config.accounts.map { it.id }.toSet()
    for (key in prefs.all.keys) {
      val account = key.substringAfter('@', "")
      if ((key.startsWith("cursor@") || key.startsWith("signedOut@")) && account !in ids) editor.remove(key)
    }
    editor.apply()
  }

  fun cursor(account: String): String? = prefs.getString("cursor@$account", null)
  fun setCursor(account: String, cursor: String) = prefs.edit().putString("cursor@$account", cursor).apply()

  /** Google refused this account's refresh token: skip it until the web layer reconfigures. */
  fun signedOut(account: String): Boolean = prefs.getBoolean("signedOut@$account", false)
  fun setSignedOut(account: String, value: Boolean) {
    if (value) prefs.edit().putBoolean("signedOut@$account", true).apply() else prefs.edit().remove("signedOut@$account").apply()
  }
  fun clearSignedOut() {
    val editor = prefs.edit()
    for (key in prefs.all.keys) if (key.startsWith("signedOut@")) editor.remove(key)
    editor.apply()
  }

  companion object {
    const val FILE = "winnow.background-sync"
    private const val KEY_CONFIG = "config"
  }
}

/** [GmailCheck.Transport] over `HttpsURLConnection`, Google's two API hosts only ([Http.ALLOWED_HOSTS]). */
object HttpsTransport : GmailCheck.Transport {
  private const val MAX_BODY = 512 * 1024

  override fun exchange(method: String, url: String, headers: List<Pair<String, String>>, body: String?): GmailCheck.Response {
    try {
      val target = URL(url)
      if (target.protocol != "https" || target.host !in Http.ALLOWED_HOSTS) return GmailCheck.Response(0, "")
      val connection = target.openConnection() as HttpsURLConnection
      connection.requestMethod = method
      connection.connectTimeout = 15_000
      connection.readTimeout = 20_000
      connection.useCaches = false
      for ((k, v) in headers) connection.setRequestProperty(k, v)
      if (body != null) {
        connection.doOutput = true
        connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      }
      val status = connection.responseCode
      val stream = if (status >= 400) connection.errorStream else connection.inputStream
      val text = stream?.use { input ->
        val bytes = input.readBytes()
        String(bytes, 0, minOf(bytes.size, MAX_BODY), Charsets.UTF_8)
      } ?: ""
      connection.disconnect()
      return GmailCheck.Response(status, text)
    } catch (_: IOException) {
      return GmailCheck.Response(0, "")
    } catch (_: Exception) {
      return GmailCheck.Response(0, "")
    }
  }
}

/** Access tokens refreshed in the background, in memory only (never written to the keychain). */
object TokenMemory : GmailCheck.TokenCache {
  private val tokens = HashMap<String, GmailCheck.CachedToken>()

  @Synchronized
  override fun remember(account: String, token: GmailCheck.CachedToken?) {
    if (token == null) tokens.remove(account) else tokens[account] = token
  }

  @Synchronized
  fun get(account: String): GmailCheck.CachedToken? = tokens[account]

  @Synchronized
  fun clear() = tokens.clear()
}

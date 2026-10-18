package app.winnow.android.notify

import app.tauri.plugin.JSObject
import java.io.IOException
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

/**
 * One HTTPS exchange, as `plan.rs` describes it: `{ method, url, headers: [[k, v]], body }`
 * in, `{ status, body }` out. `status` 0 means there was no HTTP answer at all.
 *
 * Refuses anything but https to Google's token and Gmail hosts, so a mistake upstream
 * cannot turn this into a general-purpose fetch.
 */
object Http {
  val ALLOWED_HOSTS = setOf("gmail.googleapis.com", "oauth2.googleapis.com")
  private val METHODS = setOf("GET", "POST", "PUT", "DELETE")
  private const val MAX_BODY = 256 * 1024

  fun exchange(args: JSONObject): JSObject {
    val out = JSObject()
    out.put("status", 0)
    out.put("body", "")
    try {
      val url = URL(args.getString("url"))
      val method = args.getString("method")
      if (url.protocol != "https" || url.host !in ALLOWED_HOSTS || method !in METHODS) return out
      val connection = url.openConnection() as HttpsURLConnection
      connection.requestMethod = method
      connection.connectTimeout = 15_000
      connection.readTimeout = 20_000
      connection.useCaches = false
      val headers = args.optJSONArray("headers")
      if (headers != null) {
        for (i in 0 until headers.length()) {
          val pair = headers.getJSONArray(i)
          connection.setRequestProperty(pair.getString(0), pair.getString(1))
        }
      }
      val body = if (args.isNull("body")) null else args.optString("body")
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
      out.put("status", status)
      out.put("body", text)
    } catch (_: IOException) {
      // Offline, DNS, TLS, timeout: no answer, which is what status 0 says.
    } catch (_: Exception) {
      // A malformed request from upstream is also no answer.
    }
    return out
  }
}

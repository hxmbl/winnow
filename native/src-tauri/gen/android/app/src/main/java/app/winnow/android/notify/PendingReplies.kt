package app.winnow.android.notify

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Typed replies the device is holding: written *before* anything is attempted, removed
 * only when the reply has been sent or is safely in Gmail's Drafts. So a reply survives
 * a failed send, a failed draft, no network, a revoked sign-in and the process being
 * killed mid-send. The web layer lists them once it is signed in (`notify_kept_replies`),
 * saves each to Drafts, and only then releases it (`notify_release_kept`), so a save
 * that fails at launch leaves the reply here for the next try.
 *
 * App-private SharedPreferences, like the WebView's own storage, which already holds
 * the composer's unsent drafts in the same way.
 */
object PendingReplies {
  private const val PREFS = "winnow.notify"
  private const val KEY = "pendingReplies"

  @Synchronized
  fun put(context: Context, requestId: String, entry: JSONObject) {
    val all = read(context)
    all.put(requestId, entry)
    write(context, all)
  }

  @Synchronized
  fun remove(context: Context, requestId: String) {
    val all = read(context)
    if (all.has(requestId)) {
      all.remove(requestId)
      write(context, all)
    }
  }

  /** Every kept reply, each with its `requestId`. Nothing is removed. */
  @Synchronized
  fun all(context: Context): JSONArray {
    val all = read(context)
    val out = JSONArray()
    val keys = all.keys()
    while (keys.hasNext()) {
      val key = keys.next()
      val entry = all.optJSONObject(key) ?: continue
      out.put(JSONObject(entry.toString()).put("requestId", key))
    }
    return out
  }

  private fun read(context: Context): JSONObject {
    val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
    return try {
      if (raw == null) JSONObject() else JSONObject(raw)
    } catch (_: Exception) {
      JSONObject()
    }
  }

  private fun write(context: Context, value: JSONObject) {
    // commit, not apply: the process may be about to die, and this is somebody's words.
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, value.toString()).commit()
  }
}

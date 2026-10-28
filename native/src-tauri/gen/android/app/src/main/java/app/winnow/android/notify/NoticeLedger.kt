package app.winnow.android.notify

import org.json.JSONArray
import org.json.JSONObject

/**
 * Which new-mail notifications are up, per account, and which messages have ever been
 * announced. Plain Kotlin over a JSON string, so it is a JVM unit test
 * (`NoticeLedgerTest`); [MailNotifier] keeps it in the app's private preferences.
 *
 * Two jobs:
 *
 * 1. **Dismissing itself.** A message that no longer needs attention (read, archived,
 *    deleted, snoozed, moved, in Winnow or on Gmail anywhere) takes its notification
 *    down, and the account's summary is rebuilt from what is left: a stale "3 new
 *    messages" over one notification is exactly what this exists to stop. The summary
 *    counts messages that never got their own notification too (past the five), so they
 *    are kept here with `shown = false`.
 * 2. **Never twice.** The web layer (app open) and the background service (app closed)
 *    both announce new mail. Whichever is first records the message in `seen`; the other
 *    skips it. A notification the user swiped away does not come back either.
 */
class NoticeLedger(raw: String?) {
  data class Entry(
    val gmailId: String,
    val title: String,
    val subject: String,
    /** Whether it has its own notification (false: only counted in the summary). */
    val shown: Boolean,
    val at: Long,
  )

  /** Up, by account ("" for no account: a 1.3.5-era notification). */
  private val active = LinkedHashMap<String, LinkedHashMap<String, Entry>>()
  /** Ever announced, by account, newest last. */
  private val seen = LinkedHashMap<String, LinkedHashSet<String>>()

  init {
    try {
      if (!raw.isNullOrEmpty()) {
        val json = JSONObject(raw)
        json.optJSONObject("active")?.let { accounts ->
          for (account in accounts.keys()) {
            val list = accounts.optJSONArray(account) ?: continue
            val map = LinkedHashMap<String, Entry>()
            for (i in 0 until list.length()) {
              val e = list.optJSONObject(i) ?: continue
              val id = e.optString("g")
              if (id.isEmpty()) continue
              map[id] = Entry(id, e.optString("t"), e.optString("s"), e.optBoolean("v", true), e.optLong("a"))
            }
            if (map.isNotEmpty()) active[account] = map
          }
        }
        json.optJSONObject("seen")?.let { accounts ->
          for (account in accounts.keys()) {
            val list = accounts.optJSONArray(account) ?: continue
            val set = LinkedHashSet<String>()
            for (i in 0 until list.length()) list.optString(i).takeIf { it.isNotEmpty() }?.let { set.add(it) }
            if (set.isNotEmpty()) seen[account] = set
          }
        }
      }
    } catch (_: Exception) {
      // A corrupt ledger forgets; at worst one message is announced twice.
    }
  }

  private fun key(account: String?) = account ?: ""

  fun wasSeen(account: String?, gmailId: String): Boolean = seen[key(account)]?.contains(gmailId) == true

  /** Record a batch: `shown` entries have their own notification, the rest only count. */
  fun record(account: String?, entries: List<Entry>) {
    val k = key(account)
    val map = active.getOrPut(k) { LinkedHashMap() }
    val ever = seen.getOrPut(k) { LinkedHashSet() }
    for (e in entries) {
      map[e.gmailId] = e
      ever.remove(e.gmailId)
      ever.add(e.gmailId)
    }
    while (ever.size > MAX_SEEN) ever.remove(ever.first())
    while (map.size > MAX_ACTIVE) map.remove(map.keys.first())
  }

  /** Forget `gmailIds` as up (they stay seen). Answers whether anything changed. */
  fun dismiss(account: String?, gmailIds: Collection<String>): Boolean {
    val map = active[key(account)] ?: return false
    var changed = false
    for (id in gmailIds) if (map.remove(id) != null) changed = true
    if (map.isEmpty()) active.remove(key(account))
    return changed
  }

  /** Everything of one account goes: signed out on this device. Seen is forgotten too. */
  fun clearAccount(account: String?) {
    active.remove(key(account))
    seen.remove(key(account))
  }

  fun entries(account: String?): List<Entry> = active[key(account)]?.values?.toList().orEmpty()

  fun accounts(): Set<String?> = active.keys.map { if (it.isEmpty()) null else it }.toSet()

  /**
   * Keep only the shown entries Android still has up (`alive`: their gmail ids), after
   * the user swiped some away or tapped them. When none of an account's own
   * notifications is left, its summary-only entries go too: a summary over nothing is
   * the stale count again.
   */
  fun reconcile(account: String?, alive: Set<String>): Boolean {
    val map = active[key(account)] ?: return false
    val before = map.size
    map.entries.removeAll { it.value.shown && it.key !in alive }
    if (map.values.none { it.shown }) map.clear()
    if (map.isEmpty()) active.remove(key(account))
    return map.size != before
  }

  /**
   * What the account's summary should say now, or null when nothing is left. One entry
   * still gets a summary (that message): Android cancels a group's children with its
   * summary, so a summary that is already up is updated, never taken down early.
   * Whether to post one where none is up is [MailNotifier]'s call (two or more).
   */
  fun summary(account: String?): Summary? {
    val list = entries(account).sortedByDescending { it.at }
    if (list.isEmpty()) return null
    if (list.size == 1) return Summary(list[0].title, list[0].subject, emptyList(), null)
    val names = LinkedHashSet<String>()
    list.forEach { if (it.title.isNotEmpty()) names.add(it.title) }
    val body = names.take(3).joinToString(", ") + if (names.size > 3) " and ${names.size - 3} more" else ""
    val lines = list.filter { it.shown }.take(LINES).map { "${it.title}  ${it.subject}" }
    val extra = list.size - lines.size
    return Summary("${list.size} new messages", body, lines, if (extra > 0) "+$extra more" else null)
  }

  data class Summary(val title: String, val body: String, val lines: List<String>, val more: String?)

  fun serialize(): String {
    val a = JSONObject()
    for ((account, map) in active) {
      val list = JSONArray()
      for (e in map.values) list.put(JSONObject().put("g", e.gmailId).put("t", e.title).put("s", e.subject).put("v", e.shown).put("a", e.at))
      a.put(account, list)
    }
    val s = JSONObject()
    for ((account, set) in seen) s.put(account, JSONArray(set.toList()))
    return JSONObject().put("active", a).put("seen", s).toString()
  }

  companion object {
    /** Remembered per account; enough to outlast any burst a check can announce. */
    const val MAX_SEEN = 400
    /** Counted per account. */
    const val MAX_ACTIVE = 200
    /** Lines in the summary, as many as there are message notifications. */
    const val LINES = 5
  }
}

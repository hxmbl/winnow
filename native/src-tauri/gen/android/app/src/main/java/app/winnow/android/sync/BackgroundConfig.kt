package app.winnow.android.sync

import org.json.JSONArray
import org.json.JSONObject

/** One signed-in account, as the web layer describes it for the background check. */
data class SyncAccount(
  /** `accounts.ts`'s namespace: `[a-z0-9]{4,24}`. */
  val id: String,
  /** The address, shown on a notification only when more than one account is signed in. */
  val label: String?,
  /** The account's own "New-mail notifications" switch (Accounts page). */
  val notify: Boolean,
)

/**
 * What the background check needs to know, pushed by the web layer whenever it changes
 * (`background_service_configure` in Rust → [BackgroundSyncPlugin.configure]) and kept
 * in the app's private preferences, so the service can start on boot with no web layer.
 *
 * Nothing secret is in here: the tokens stay in the Keystore-backed keychain the Rust
 * side writes ([KeyringReader] only reads them). Sender addresses are, because muted
 * and hidden senders must not notify in the background either.
 */
data class BackgroundConfig(
  /** "Keep syncing while closed" is on, notifications are on, and someone is signed in. */
  val enabled: Boolean,
  val accounts: List<SyncAccount>,
  /** The account the app last had open; it always notifies, others follow their switch. */
  val activeAccount: String?,
  /** The web layer's flags: 1 reply, 2 delete, 4 mark read (Settings → Notifications). */
  val actions: Int,
  /** Lock screen says "New message" rather than sender and subject. */
  val hidePreview: Boolean,
  /** Muted and hidden senders, lowercased: their mail never notifies. */
  val quietSenders: Set<String>,
) {
  /** Whether new mail in `account` may notify at all. */
  fun notifies(account: String): Boolean {
    val record = accounts.firstOrNull { it.id == account } ?: return false
    return account == activeAccount || record.notify
  }

  /** The label a notification carries: the address, only with several accounts. */
  fun labelFor(account: String): String? =
    if (accounts.size > 1) accounts.firstOrNull { it.id == account }?.label?.ifEmpty { null } else null

  fun toJson(): JSONObject {
    val list = JSONArray()
    for (a in accounts) {
      list.put(JSONObject().put("id", a.id).put("label", a.label ?: JSONObject.NULL).put("notify", a.notify))
    }
    return JSONObject()
      .put("enabled", enabled)
      .put("accounts", list)
      .put("activeAccount", activeAccount ?: JSONObject.NULL)
      .put("actions", actions)
      .put("hidePreview", hidePreview)
      .put("quietSenders", JSONArray(quietSenders.sorted()))
  }

  companion object {
    private val ACCOUNT_ID = Regex("^[a-z0-9]{4,24}$")
    /** The most accounts Winnow signs in at once (`MAX_ACCOUNTS` in `accounts.ts`). */
    const val MAX_ACCOUNTS = 5

    val OFF = BackgroundConfig(false, emptyList(), null, 7, false, emptySet())

    /**
     * Read what the web layer sent (or what was saved). Anything malformed is dropped,
     * never guessed at: an account with a bad id is not an account, and a config with
     * no valid account is off.
     */
    fun fromJson(json: JSONObject?): BackgroundConfig {
      if (json == null) return OFF
      val accounts = ArrayList<SyncAccount>()
      val list = json.optJSONArray("accounts")
      if (list != null) {
        for (i in 0 until list.length()) {
          val item = list.optJSONObject(i) ?: continue
          val id = item.optString("id")
          if (!ACCOUNT_ID.matches(id) || accounts.any { it.id == id }) continue
          val label = if (item.isNull("label")) null else item.optString("label").ifEmpty { null }
          accounts.add(SyncAccount(id, label, item.optBoolean("notify", true)))
          if (accounts.size == MAX_ACCOUNTS) break
        }
      }
      val active = if (json.isNull("activeAccount")) null else json.optString("activeAccount").takeIf { id -> accounts.any { it.id == id } }
      val quiet = HashSet<String>()
      val senders = json.optJSONArray("quietSenders")
      if (senders != null) {
        for (i in 0 until senders.length()) {
          val s = senders.optString(i).trim().lowercase()
          if (s.isNotEmpty()) quiet.add(s)
        }
      }
      return BackgroundConfig(
        enabled = json.optBoolean("enabled", false) && accounts.isNotEmpty(),
        accounts = accounts,
        activeAccount = active,
        actions = json.optInt("actions", 7) and 7,
        hidePreview = json.optBoolean("hidePreview", false),
        quietSenders = quiet,
      )
    }
  }
}

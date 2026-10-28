package app.winnow.android.sync

import java.net.URLEncoder
import org.json.JSONArray
import org.json.JSONObject

/**
 * One background check of one account, as plain Kotlin: no Android, no sockets. The
 * service hands it a [Transport] (`HttpsURLConnection`, Google's two API hosts only);
 * the JVM tests hand it a fake. Everything that can be wrong about a check (which
 * request, when to refresh, what a 404 means, which mail is news and which
 * notifications are stale) is decided here.
 *
 * **Why history.list.** It is the cheapest way Gmail says "something changed": 2 quota
 * units a call, against 5 for the light sync's `messages.list` and 20 for a full read.
 * A call a minute per account is ~2,900 units a day, far under the per-user limit
 * (15,000 a *minute*). IMAP IDLE would push instead of poll, but needs the restricted
 * `https://mail.google.com/` scope; see the Research issue in Linear.
 *
 * **What it reports.** New mail: messages added since the cursor that are still unread
 * and in the Inbox when their metadata is read (5 units each, newest first, at most
 * [MAX_FETCH]). Stale: messages whose notification should go, because on Gmail (the web,
 * another device, or Winnow) they were read, left the Inbox, went to Trash or Spam, or
 * were deleted.
 *
 * **Tokens.** Read from the keychain the web layer writes and never written back, like
 * the notification actions in `plan.rs`: the web layer's `TokenManager` owns that entry.
 * A refreshed access token is kept in memory for the next checks instead ([TokenCache]).
 */
object GmailCheck {
  const val GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
  const val TOKEN_URL = "https://oauth2.googleapis.com/token"

  /** Refresh this long before the recorded expiry, as `tokens.ts` and `plan.rs` do. */
  const val EXPIRY_SKEW_MS = 60_000L
  /** New messages read per check, for notifications (five get their own; the rest are counted). */
  const val MAX_FETCH = 8
  /** History pages read per check; anything past it waits for the next one. */
  const val MAX_PAGES = 5

  val HISTORY_TYPES = listOf("messageAdded", "messageDeleted", "labelAdded", "labelRemoved")

  /** One HTTPS exchange. `status` 0 means no HTTP answer at all (offline, DNS, timeout). */
  data class Response(val status: Int, val body: String)

  fun interface Transport {
    fun exchange(method: String, url: String, headers: List<Pair<String, String>>, body: String?): Response
  }

  // ── Credentials ───────────────────────────────────────────────────────────

  /** The keychain's `gmail.tokens@<id>` (`TokenSet` in `dto.ts`). */
  data class Tokens(val accessToken: String, val refreshToken: String?, val expiresAt: Long)

  /** The keychain's `google.oauth-client` (`OAuthClientCredentials`). */
  data class Client(val clientId: String, val clientSecret: String?)

  fun parseTokens(raw: String?): Tokens? {
    if (raw.isNullOrBlank()) return null
    return try {
      val json = JSONObject(raw)
      val access = json.optString("accessToken")
      val refresh = if (json.isNull("refreshToken")) null else json.optString("refreshToken").ifEmpty { null }
      if (access.isEmpty() && refresh == null) return null
      // JS writes epoch milliseconds, possibly as a float.
      Tokens(access, refresh, json.optDouble("expiresAt", 0.0).toLong())
    } catch (_: Exception) {
      null
    }
  }

  fun parseClient(raw: String?): Client? {
    if (raw.isNullOrBlank()) return null
    return try {
      val json = JSONObject(raw)
      val id = json.optString("clientId")
      if (id.isEmpty()) return null
      Client(id, if (json.isNull("clientSecret")) null else json.optString("clientSecret").ifEmpty { null })
    } catch (_: Exception) {
      null
    }
  }

  /** An access token refreshed by an earlier check, in memory only. */
  data class CachedToken(val accessToken: String, val expiresAt: Long)

  fun interface TokenCache {
    fun remember(account: String, token: CachedToken?)
  }

  // ── Outcome ───────────────────────────────────────────────────────────────

  /** What a new message's notification needs. */
  data class Message(
    val gmailId: String,
    val threadId: String?,
    val senderName: String,
    val senderAddress: String,
    val subject: String,
    val snippet: String,
    val receivedAt: Long,
    val labels: Set<String>,
  ) {
    val unreadInInbox: Boolean get() = "UNREAD" in labels && "INBOX" in labels && "TRASH" !in labels && "SPAM" !in labels
  }

  sealed class Result {
    /** The first check of an account (or after Gmail forgot the cursor): where it starts from. Mail already there is not news. */
    data class Seeded(val cursor: String) : Result()
    data class Checked(val cursor: String, val fresh: List<Message>, val stale: Set<String>) : Result()
    /** No HTTP answer: try again later, cursor unchanged. */
    object Offline : Result()
    /** Signed out here, or Google refused the refresh: nothing works until the user signs in again. */
    object SignedOut : Result()
    /** Anything else Google said no to (rate limit, 5xx): back off, cursor unchanged. */
    data class Failed(val status: Int) : Result()
  }

  // ── The check ─────────────────────────────────────────────────────────────

  /**
   * Check `account` from `cursor` (its last history id; `null` the first time).
   * `cached` is the access token an earlier check refreshed, if any.
   */
  fun run(
    account: String,
    tokensRaw: String?,
    clientRaw: String?,
    cursor: String?,
    cached: CachedToken?,
    now: Long,
    transport: Transport,
    cache: TokenCache,
    quietSenders: Set<String> = emptySet(),
  ): Result {
    val session = Session(account, parseTokens(tokensRaw), parseClient(clientRaw), cached, now, transport, cache)
    if (session.tokens == null) return Result.SignedOut
    if (cursor.isNullOrEmpty()) return seed(session)

    val delta = HistoryDelta()
    var pageToken: String? = null
    var pages = 0
    var latest: String = cursor
    do {
      val page = session.call("GET", historyUrl(cursor, pageToken))
      if (page == null) {
        // The cursor is older than Gmail keeps (about a week): start again from now,
        // announcing nothing rather than guessing what was missed.
        return if (session.lastStatus == 404 && !session.signedOut) seed(session) else session.failure()
      }
      delta.add(page)
      page.optString("historyId").takeIf { it.isNotEmpty() }?.let { latest = it }
      pageToken = page.optString("nextPageToken").ifEmpty { null }
      pages += 1
    } while (pageToken != null && pages < MAX_PAGES)

    // More history than this check reads: carry on from the last record seen, not the
    // mailbox's latest id, so nothing in between is skipped.
    if (pageToken != null) delta.lastRecordId?.let { latest = it }

    val fresh = ArrayList<Message>()
    for (gmailId in delta.candidates().take(MAX_FETCH)) {
      val json = session.call("GET", metadataUrl(gmailId))
      if (json == null) {
        // Gone already (deleted, or moved out of reach): its notification, if any, goes.
        if (session.lastStatus == 404) delta.stale.add(gmailId)
        if (session.lastStatus == 0 || session.signedOut) return session.failure()
        continue
      }
      val message = parseMessage(json) ?: continue
      if (!message.unreadInInbox) {
        delta.stale.add(gmailId)
        continue
      }
      if (message.senderAddress.lowercase() in quietSenders) continue
      fresh.add(message)
    }
    fresh.sortByDescending { it.receivedAt }
    return Result.Checked(latest, fresh, delta.stale.toSet() - fresh.map { it.gmailId }.toSet())
  }

  private fun seed(session: Session): Result {
    val profile = session.call("GET", "$GMAIL_API/profile") ?: return session.failure()
    val historyId = profile.optString("historyId")
    return if (historyId.isEmpty()) Result.Failed(200) else Result.Seeded(historyId)
  }

  fun historyUrl(cursor: String, pageToken: String?): String {
    val q = StringBuilder("$GMAIL_API/history?startHistoryId=").append(enc(cursor)).append("&maxResults=100")
    for (type in HISTORY_TYPES) q.append("&historyTypes=").append(type)
    if (pageToken != null) q.append("&pageToken=").append(enc(pageToken))
    return q.toString()
  }

  fun metadataUrl(gmailId: String): String =
    "$GMAIL_API/messages/${enc(gmailId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject"

  private fun enc(value: String) = URLEncoder.encode(value, "UTF-8")

  /** Gmail ids are hex today; anything outside this set never reaches a URL or a notification. */
  fun validGmailId(id: String): Boolean = id.isNotEmpty() && id.length <= 64 && id.all { it.code < 128 && it.isLetterOrDigit() }

  // ── Parsing ───────────────────────────────────────────────────────────────

  /**
   * What a run of history records says. A message added and then read, archived or
   * deleted in the same window is both a candidate and stale; reading its metadata
   * settles which ([run]).
   */
  class HistoryDelta {
    /** Messages added, oldest first, as Gmail lists the records. */
    val added = LinkedHashSet<String>()
    val stale = LinkedHashSet<String>()
    var lastRecordId: String? = null
      private set

    fun add(page: JSONObject) {
      val history = page.optJSONArray("history") ?: return
      for (i in 0 until history.length()) {
        val record = history.optJSONObject(i) ?: continue
        record.optString("id").takeIf { it.isNotEmpty() }?.let { lastRecordId = it }
        each(record, "messagesAdded") { id, labels ->
          // Mail the user sent, drafts and chats are not news; neither is mail a filter
          // filed past the Inbox, or that arrived already read.
          if ("INBOX" in labels && "UNREAD" in labels && "DRAFT" !in labels && "SPAM" !in labels && "TRASH" !in labels) {
            added.add(id)
            stale.remove(id)
          }
        }
        each(record, "messagesDeleted") { id, _ ->
          stale.add(id)
          added.remove(id)
        }
        each(record, "labelsRemoved", "labelIds") { id, labels ->
          if ("UNREAD" in labels || "INBOX" in labels) stale.add(id)
        }
        each(record, "labelsAdded", "labelIds") { id, labels ->
          if ("TRASH" in labels || "SPAM" in labels) stale.add(id)
        }
      }
    }

    /** New mail to read the metadata of, newest first. */
    fun candidates(): List<String> = added.toList().asReversed()

    private fun each(record: JSONObject, key: String, labelsKey: String? = null, block: (String, Set<String>) -> Unit) {
      val list = record.optJSONArray(key) ?: return
      for (j in 0 until list.length()) {
        val entry = list.optJSONObject(j) ?: continue
        val message = entry.optJSONObject("message") ?: continue
        val id = message.optString("id")
        if (!validGmailId(id)) continue
        // messagesAdded carries the message's labels; labelsAdded/Removed the changed ones.
        val labelsJson = if (labelsKey != null) entry.optJSONArray(labelsKey) else message.optJSONArray("labelIds")
        val labels = HashSet<String>()
        if (labelsJson != null) for (k in 0 until labelsJson.length()) labels.add(labelsJson.optString(k))
        block(id, labels)
      }
    }
  }

  /** A `format=metadata` message, or null when it is not one. */
  fun parseMessage(json: JSONObject): Message? {
    val id = json.optString("id")
    if (!validGmailId(id)) return null
    val labels = HashSet<String>()
    json.optJSONArray("labelIds")?.let { for (i in 0 until it.length()) labels.add(it.optString(i)) }
    var from = ""
    var subject = ""
    val headers = json.optJSONObject("payload")?.optJSONArray("headers")
    if (headers != null) {
      for (i in 0 until headers.length()) {
        val h = headers.optJSONObject(i) ?: continue
        when (h.optString("name").lowercase()) {
          "from" -> if (from.isEmpty()) from = h.optString("value")
          "subject" -> if (subject.isEmpty()) subject = h.optString("value")
        }
      }
    }
    val (name, address) = parseFrom(from)
    return Message(
      gmailId = id,
      threadId = json.optString("threadId").ifEmpty { null },
      senderName = name,
      senderAddress = address,
      subject = subject.trim().ifEmpty { "(no subject)" },
      snippet = decodeEntities(json.optString("snippet")).trim(),
      receivedAt = json.optString("internalDate").toLongOrNull() ?: 0L,
      labels = labels,
    )
  }

  /**
   * `"Ada Lovelace" <ada@example.com>` → ("Ada Lovelace", "ada@example.com"). A bare
   * address names itself by the part before the @.
   */
  fun parseFrom(raw: String): Pair<String, String> {
    val value = raw.trim()
    val open = value.lastIndexOf('<')
    val close = value.lastIndexOf('>')
    if (open >= 0 && close > open) {
      val address = value.substring(open + 1, close).trim()
      val name = value.substring(0, open).trim().trim('"').trim()
      return Pair(name.ifEmpty { address.substringBefore('@') }, address)
    }
    return Pair(value.substringBefore('@').ifEmpty { value }, value)
  }

  /** Gmail's snippet is HTML-escaped. Only the entities it uses; `&amp;` last so `&amp;lt;` stays `&lt;`. */
  fun decodeEntities(text: String): String =
    text.replace("&#39;", "'").replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")

  // ── A notification's button, with no Rust in the process ─────────────────

  /**
   * Delete, Mark read or Undo pressed on a notification while Winnow's Rust half is not
   * running (Android started the process for the background service, not the app). The
   * same label changes as `plan.rs`'s `execute`: Trash on and Inbox off; Unread off;
   * Inbox back and Trash off. Answers an outcome `BackgroundActions.finishFor` words as
   * `plan::finish_for` does: `trashed`, `read`, `restored`, `offline`, `auth`, `failed`,
   * `invalid`.
   */
  fun act(
    account: String?,
    action: String,
    gmailId: String,
    tokensRaw: String?,
    clientRaw: String?,
    cached: CachedToken?,
    now: Long,
    transport: Transport,
    cache: TokenCache,
  ): String {
    if (!validGmailId(gmailId)) return "invalid"
    val (add, remove, done) = when (action) {
      "trash" -> Triple(listOf("TRASH"), listOf("INBOX"), "trashed")
      "read" -> Triple(emptyList(), listOf("UNREAD"), "read")
      "untrash" -> Triple(listOf("INBOX"), listOf("TRASH"), "restored")
      else -> return "invalid"
    }
    val session = Session(account ?: "", parseTokens(tokensRaw), parseClient(clientRaw), cached, now, transport, cache)
    if (session.tokens == null) return "auth"
    val body = JSONObject().put("addLabelIds", JSONArray(add)).put("removeLabelIds", JSONArray(remove)).toString()
    if (session.call("POST", "$GMAIL_API/messages/${enc(gmailId)}/modify", body) != null) return done
    return when {
      session.signedOut -> "auth"
      session.lastStatus == 0 -> "offline"
      else -> "failed"
    }
  }

  // ── One account's calls ───────────────────────────────────────────────────

  private class Session(
    val account: String,
    val tokens: Tokens?,
    val client: Client?,
    cached: CachedToken?,
    val now: Long,
    val transport: Transport,
    val cache: TokenCache,
  ) {
    var lastStatus = 0
    private var auth = false
    val signedOut: Boolean get() = auth
    private var refreshed = false
    private var access: String? = when {
      cached != null && cached.expiresAt - EXPIRY_SKEW_MS > now -> cached.accessToken
      tokens != null && tokens.accessToken.isNotEmpty() && tokens.expiresAt - EXPIRY_SKEW_MS > now -> tokens.accessToken
      else -> null
    }

    fun failure(): Result = when {
      auth -> Result.SignedOut
      lastStatus == 0 -> Result.Offline
      else -> Result.Failed(lastStatus)
    }

    /** One Gmail call. A 401 gets exactly one refresh and one replay, as in `client.ts`. */
    fun call(method: String, url: String, body: String? = null): JSONObject? {
      val token = access ?: refresh() ?: return null
      fun headers(t: String) =
        if (body == null) listOf("Authorization" to "Bearer $t") else listOf("Authorization" to "Bearer $t", "Content-Type" to "application/json")
      var response = transport.exchange(method, url, headers(token), body)
      if (response.status == 401 && !refreshed) {
        val again = refresh() ?: return null
        response = transport.exchange(method, url, headers(again), body)
      }
      lastStatus = response.status
      if (response.status == 401 || (response.status == 403 && isAuthForbidden(response.body))) {
        auth = true
        return null
      }
      if (response.status !in 200..299) return null
      return try {
        JSONObject(response.body)
      } catch (_: Exception) {
        null
      }
    }

    private fun refresh(): String? {
      if (refreshed) {
        auth = true
        return null
      }
      refreshed = true
      val refreshToken = tokens?.refreshToken
      val client = client
      if (refreshToken == null || client == null) {
        auth = true
        return null
      }
      val form = StringBuilder()
        .append("client_id=").append(enc(client.clientId))
        .append("&refresh_token=").append(enc(refreshToken))
        .append("&grant_type=refresh_token")
      if (client.clientSecret != null) form.append("&client_secret=").append(enc(client.clientSecret))
      val response = transport.exchange(
        "POST",
        TOKEN_URL,
        listOf("Content-Type" to "application/x-www-form-urlencoded"),
        form.toString(),
      )
      lastStatus = response.status
      if (response.status == 0) return null
      if (response.status !in 200..299) {
        // invalid_grant: revoked, expired, or the client was deleted. Only the user can fix it.
        if (response.status == 400 || response.status == 401) {
          auth = true
          cache.remember(account, null)
        }
        return null
      }
      return try {
        val json = JSONObject(response.body)
        val token = json.optString("access_token")
        if (token.isEmpty()) return null
        val expiresAt = now + json.optLong("expires_in", 3600) * 1000
        access = token
        cache.remember(account, CachedToken(token, expiresAt))
        token
      } catch (_: Exception) {
        null
      }
    }

    /** A 403 that means "this token may not do that" rather than a rate limit. */
    private fun isAuthForbidden(body: String): Boolean {
      val reason = try {
        JSONObject(body).optJSONObject("error")?.optJSONArray("errors")?.optJSONObject(0)?.optString("reason").orEmpty()
      } catch (_: Exception) {
        ""
      }
      return reason == "insufficientPermissions" || reason == "authError" || reason == "forbidden"
    }
  }

  // ── Pacing ────────────────────────────────────────────────────────────────

  /** Between checks while things work: about a minute (the owner chose near-instant). */
  const val INTERVAL_MS = 60_000L
  /** The longest the service waits after failures in a row. */
  const val MAX_BACKOFF_MS = 15 * 60_000L

  /** How long to wait after `failures` failed checks in a row (0: the normal interval). */
  fun delayAfter(failures: Int): Long {
    if (failures <= 0) return INTERVAL_MS
    var delay = INTERVAL_MS
    repeat(minOf(failures, 8)) { delay *= 2 }
    return minOf(delay, MAX_BACKOFF_MS)
  }
}

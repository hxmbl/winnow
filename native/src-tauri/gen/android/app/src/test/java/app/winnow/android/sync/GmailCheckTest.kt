package app.winnow.android.sync

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GmailCheckTest {
  private val now = 1_800_000_000_000L
  private val freshTokens = JSONObject().put("accessToken", "at-1").put("refreshToken", "rt-1").put("expiresAt", now + 3_600_000.0).toString()
  private val staleTokens = JSONObject().put("accessToken", "old").put("refreshToken", "rt-1").put("expiresAt", now - 1.0).toString()
  private val client = JSONObject().put("clientId", "cid.apps.googleusercontent.com").put("clientSecret", JSONObject.NULL).toString()

  /** A fake Gmail: answers by URL prefix, records every request. */
  private class FakeGmail(val routes: MutableMap<String, (String) -> GmailCheck.Response>) : GmailCheck.Transport {
    val calls = ArrayList<Triple<String, String, List<Pair<String, String>>>>()
    val bodies = ArrayList<String?>()
    override fun exchange(method: String, url: String, headers: List<Pair<String, String>>, body: String?): GmailCheck.Response {
      calls.add(Triple(method, url, headers))
      bodies.add(body)
      val route = routes.entries.firstOrNull { url.startsWith(it.key) } ?: return GmailCheck.Response(0, "")
      return route.value(url)
    }
  }

  private val remembered = HashMap<String, GmailCheck.CachedToken?>()
  private val cache = GmailCheck.TokenCache { account, token -> remembered[account] = token }

  private fun ok(json: JSONObject) = GmailCheck.Response(200, json.toString())

  private fun added(id: String, vararg labels: String) =
    JSONObject().put("message", JSONObject().put("id", id).put("labelIds", JSONArray(labels.toList())))

  private fun changed(id: String, vararg labels: String) =
    JSONObject().put("message", JSONObject().put("id", id)).put("labelIds", JSONArray(labels.toList()))

  private fun meta(id: String, from: String, subject: String, vararg labels: String) = ok(
    JSONObject()
      .put("id", id)
      .put("threadId", "t$id")
      .put("labelIds", JSONArray(labels.toList()))
      .put("snippet", "Tom &amp; Jerry&#39;s plan")
      .put("internalDate", "1799999999000")
      .put("payload", JSONObject().put("headers", JSONArray().put(JSONObject().put("name", "From").put("value", from)).put(JSONObject().put("name", "Subject").put("value", subject)))),
  )

  private fun run(transport: GmailCheck.Transport, cursor: String? = "100", tokens: String = freshTokens, quiet: Set<String> = emptySet()) =
    GmailCheck.run("acct1", tokens, client, cursor, null, now, transport, cache, quiet)

  @Test
  fun `the first check only records where to start`() {
    val gmail = FakeGmail(mutableMapOf("${GmailCheck.GMAIL_API}/profile" to { _ -> ok(JSONObject().put("historyId", "555")) }))
    assertEquals(GmailCheck.Result.Seeded("555"), run(gmail, cursor = null))
    assertEquals(1, gmail.calls.size)
  }

  @Test
  fun `new unread inbox mail is announced, newest first, and the cursor moves`() {
    val history = JSONObject().put("historyId", "130").put(
      "history",
      JSONArray()
        .put(JSONObject().put("id", "101").put("messagesAdded", JSONArray().put(added("aa1", "INBOX", "UNREAD"))))
        .put(JSONObject().put("id", "102").put("messagesAdded", JSONArray().put(added("aa2", "INBOX", "UNREAD", "CATEGORY_PERSONAL")))),
    )
    val gmail = FakeGmail(
      mutableMapOf(
        "${GmailCheck.GMAIL_API}/history" to { _ -> ok(history) },
        "${GmailCheck.GMAIL_API}/messages/aa1" to { _ -> meta("aa1", "\"Ada Lovelace\" <ada@example.com>", "Engines", "INBOX", "UNREAD") },
        "${GmailCheck.GMAIL_API}/messages/aa2" to { _ -> meta("aa2", "bob@example.com", "", "INBOX", "UNREAD") },
      ),
    )
    val result = run(gmail) as GmailCheck.Result.Checked
    assertEquals("130", result.cursor)
    assertEquals(listOf("aa1", "aa2").toSet(), result.fresh.map { it.gmailId }.toSet())
    val ada = result.fresh.first { it.gmailId == "aa1" }
    assertEquals("Ada Lovelace", ada.senderName)
    assertEquals("ada@example.com", ada.senderAddress)
    assertEquals("Tom & Jerry's plan", ada.snippet)
    val bob = result.fresh.first { it.gmailId == "aa2" }
    assertEquals("bob", bob.senderName)
    assertEquals("(no subject)", bob.subject)
    // Newest record read first.
    assertTrue(gmail.calls[1].second.contains("/messages/aa2"))
    // Every Gmail call carries the stored access token; no refresh was needed.
    assertTrue(gmail.calls.all { (_, _, h) -> h.contains("Authorization" to "Bearer at-1") })
  }

  @Test
  fun `the history request asks for every change that can make a notification stale`() {
    val url = GmailCheck.historyUrl("42", "tok en")
    for (type in listOf("messageAdded", "messageDeleted", "labelAdded", "labelRemoved")) assertTrue(url.contains("historyTypes=$type"))
    assertTrue(url.contains("startHistoryId=42"))
    assertTrue(url.contains("pageToken=tok+en"))
  }

  @Test
  fun `mail read, archived, trashed or deleted anywhere makes its notification stale`() {
    val history = JSONObject().put("historyId", "140").put(
      "history",
      JSONArray()
        .put(JSONObject().put("id", "131").put("labelsRemoved", JSONArray().put(changed("r1", "UNREAD"))))
        .put(JSONObject().put("id", "132").put("labelsRemoved", JSONArray().put(changed("r2", "INBOX"))))
        .put(JSONObject().put("id", "133").put("labelsAdded", JSONArray().put(changed("r3", "TRASH"))))
        .put(JSONObject().put("id", "134").put("messagesDeleted", JSONArray().put(JSONObject().put("message", JSONObject().put("id", "r4")))))
        .put(JSONObject().put("id", "135").put("labelsAdded", JSONArray().put(changed("r5", "STARRED")))),
    )
    val gmail = FakeGmail(mutableMapOf("${GmailCheck.GMAIL_API}/history" to { _ -> ok(history) }))
    val result = run(gmail) as GmailCheck.Result.Checked
    assertEquals(setOf("r1", "r2", "r3", "r4"), result.stale)
    assertTrue(result.fresh.isEmpty())
  }

  @Test
  fun `mail that arrived and was read before the check is stale, not news`() {
    val history = JSONObject().put("historyId", "150").put(
      "history",
      JSONArray()
        .put(JSONObject().put("id", "141").put("messagesAdded", JSONArray().put(added("b1", "INBOX", "UNREAD"))))
        .put(JSONObject().put("id", "142").put("labelsRemoved", JSONArray().put(changed("b1", "UNREAD")))),
    )
    val gmail = FakeGmail(
      mutableMapOf(
        "${GmailCheck.GMAIL_API}/history" to { _ -> ok(history) },
        "${GmailCheck.GMAIL_API}/messages/b1" to { _ -> meta("b1", "a@b.c", "Hi", "INBOX") },
      ),
    )
    val result = run(gmail) as GmailCheck.Result.Checked
    assertTrue(result.fresh.isEmpty())
    assertEquals(setOf("b1"), result.stale)
  }

  @Test
  fun `sent mail, drafts, spam and mail filed past the inbox are never news`() {
    val history = JSONObject().put("historyId", "160").put(
      "history",
      JSONArray().put(
        JSONObject().put("id", "151").put(
          "messagesAdded",
          JSONArray().put(added("s1", "SENT")).put(added("s2", "DRAFT", "INBOX", "UNREAD")).put(added("s3", "SPAM", "UNREAD")).put(added("s4", "Label_1", "UNREAD")).put(added("s5", "INBOX")),
        ),
      ),
    )
    val gmail = FakeGmail(mutableMapOf("${GmailCheck.GMAIL_API}/history" to { _ -> ok(history) }))
    val result = run(gmail) as GmailCheck.Result.Checked
    assertTrue(result.fresh.isEmpty())
    assertEquals(1, gmail.calls.size)
  }

  @Test
  fun `muted and hidden senders arrive silently`() {
    val history = JSONObject().put("historyId", "170").put("history", JSONArray().put(JSONObject().put("id", "161").put("messagesAdded", JSONArray().put(added("q1", "INBOX", "UNREAD")))))
    val gmail = FakeGmail(
      mutableMapOf(
        "${GmailCheck.GMAIL_API}/history" to { _ -> ok(history) },
        "${GmailCheck.GMAIL_API}/messages/q1" to { _ -> meta("q1", "News <News@Example.com>", "Deals", "INBOX", "UNREAD") },
      ),
    )
    val result = run(gmail, quiet = setOf("news@example.com")) as GmailCheck.Result.Checked
    assertTrue(result.fresh.isEmpty())
    assertEquals("170", result.cursor)
  }

  @Test
  fun `a cursor Gmail has forgotten starts again from now, announcing nothing`() {
    val gmail = FakeGmail(
      mutableMapOf(
        "${GmailCheck.GMAIL_API}/history" to { _ -> GmailCheck.Response(404, "{}") },
        "${GmailCheck.GMAIL_API}/profile" to { _ -> ok(JSONObject().put("historyId", "999")) },
      ),
    )
    assertEquals(GmailCheck.Result.Seeded("999"), run(gmail))
  }

  @Test
  fun `an expired access token is refreshed with the user's own client, in memory only`() {
    val history = JSONObject().put("historyId", "101")
    val gmail = FakeGmail(
      mutableMapOf(
        GmailCheck.TOKEN_URL to { _ -> ok(JSONObject().put("access_token", "at-2").put("expires_in", 3599)) },
        "${GmailCheck.GMAIL_API}/history" to { _ -> ok(history) },
      ),
    )
    val result = run(gmail, tokens = staleTokens)
    assertTrue(result is GmailCheck.Result.Checked)
    assertEquals("POST", gmail.calls[0].first)
    val form = gmail.bodies[0]!!
    assertTrue(form.contains("client_id=cid.apps.googleusercontent.com"))
    assertTrue(form.contains("refresh_token=rt-1"))
    assertTrue(form.contains("grant_type=refresh_token"))
    assertTrue(!form.contains("client_secret"))
    assertTrue(gmail.calls[1].third.contains("Authorization" to "Bearer at-2"))
    assertEquals("at-2", remembered["acct1"]?.accessToken)
  }

  @Test
  fun `a 401 gets one refresh and one replay`() {
    var historyCalls = 0
    val gmail = FakeGmail(
      mutableMapOf(
        GmailCheck.TOKEN_URL to { _ -> ok(JSONObject().put("access_token", "at-3").put("expires_in", 3599)) },
        "${GmailCheck.GMAIL_API}/history" to { _ ->
          historyCalls += 1
          if (historyCalls == 1) GmailCheck.Response(401, "{}") else ok(JSONObject().put("historyId", "101"))
        },
      ),
    )
    assertTrue(run(gmail) is GmailCheck.Result.Checked)
    assertEquals(2, historyCalls)
  }

  @Test
  fun `a refused refresh token means signing in again`() {
    val gmail = FakeGmail(mutableMapOf(GmailCheck.TOKEN_URL to { _ -> GmailCheck.Response(400, "{\"error\":\"invalid_grant\"}") }))
    assertEquals(GmailCheck.Result.SignedOut, run(gmail, tokens = staleTokens))
    assertEquals(GmailCheck.Result.SignedOut, GmailCheck.run("acct1", null, client, "1", null, now, gmail, cache))
  }

  @Test
  fun `no answer is offline and a rate limit is a failure, both keeping the cursor`() {
    assertEquals(GmailCheck.Result.Offline, run(FakeGmail(mutableMapOf())))
    val limited = FakeGmail(mutableMapOf("${GmailCheck.GMAIL_API}/history" to { _ -> GmailCheck.Response(429, "{}") }))
    assertEquals(GmailCheck.Result.Failed(429), run(limited))
  }

  @Test
  fun `more history than one check reads resumes from the last record, not the newest id`() {
    val page = JSONObject().put("historyId", "900").put("nextPageToken", "more")
      .put("history", JSONArray().put(JSONObject().put("id", "205")))
    val gmail = FakeGmail(mutableMapOf("${GmailCheck.GMAIL_API}/history" to { _ -> ok(page) }))
    val result = run(gmail) as GmailCheck.Result.Checked
    assertEquals(GmailCheck.MAX_PAGES, gmail.calls.size)
    assertEquals("205", result.cursor)
  }

  @Test
  fun `a notification button without Rust makes the same label change as plan_rs`() {
    val gmail = FakeGmail(mutableMapOf("${GmailCheck.GMAIL_API}/messages/abc/modify" to { _ -> ok(JSONObject().put("id", "abc")) }))
    assertEquals("trashed", GmailCheck.act("acct1", "trash", "abc", freshTokens, client, null, now, gmail, cache))
    val body = JSONObject(gmail.bodies[0]!!)
    assertEquals("TRASH", body.getJSONArray("addLabelIds").getString(0))
    assertEquals("INBOX", body.getJSONArray("removeLabelIds").getString(0))
    assertEquals("read", GmailCheck.act("acct1", "read", "abc", freshTokens, client, null, now, gmail, cache))
    assertEquals("UNREAD", JSONObject(gmail.bodies[1]!!).getJSONArray("removeLabelIds").getString(0))
    assertEquals("restored", GmailCheck.act("acct1", "untrash", "abc", freshTokens, client, null, now, gmail, cache))
    assertEquals("invalid", GmailCheck.act("acct1", "trash", "../x", freshTokens, client, null, now, gmail, cache))
    assertEquals("offline", GmailCheck.act("acct1", "read", "zzz", freshTokens, client, null, now, gmail, cache))
    assertEquals("auth", GmailCheck.act("acct1", "read", "abc", null, client, null, now, gmail, cache))
  }

  @Test
  fun `ids that are not Gmail ids never reach a URL`() {
    assertTrue(GmailCheck.validGmailId("18f2a9c0d1e2"))
    for (bad in listOf("", "a/b", "a b", "é1", "x".repeat(65))) assertTrue(!GmailCheck.validGmailId(bad))
  }

  @Test
  fun `failures back off to fifteen minutes and success returns to a minute`() {
    assertEquals(60_000L, GmailCheck.delayAfter(0))
    assertEquals(120_000L, GmailCheck.delayAfter(1))
    assertEquals(GmailCheck.MAX_BACKOFF_MS, GmailCheck.delayAfter(20))
  }
}

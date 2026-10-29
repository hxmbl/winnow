package app.winnow.android.sync

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BackgroundConfigTest {
  private fun account(id: String, label: String?, notify: Boolean = true) =
    JSONObject().put("id", id).put("label", label ?: JSONObject.NULL).put("notify", notify)

  @Test
  fun `what the web layer sends survives the round trip`() {
    val json = JSONObject()
      .put("enabled", true)
      .put("accounts", JSONArray().put(account("abcd1234", "me@example.com")).put(account("work9999", "me@work.example", false)))
      .put("activeAccount", "abcd1234")
      .put("actions", 6)
      .put("hidePreview", true)
      .put("quietSenders", JSONArray().put(" News@Example.com "))
    val config = BackgroundConfig.fromJson(json)
    assertEquals(config, BackgroundConfig.fromJson(config.toJson()))
    assertTrue(config.enabled)
    assertEquals(6, config.actions)
    assertEquals(setOf("news@example.com"), config.quietSenders)
  }

  @Test
  fun `the open account always notifies, others follow their own switch`() {
    val config = BackgroundConfig.fromJson(
      JSONObject().put("enabled", true).put("activeAccount", "work9999")
        .put("accounts", JSONArray().put(account("abcd1234", "a@x", false)).put(account("work9999", "b@x", false)).put(account("home7777", "c@x", true))),
    )
    assertTrue(config.notifies("work9999"))
    assertFalse(config.notifies("abcd1234"))
    assertTrue(config.notifies("home7777"))
    assertFalse(config.notifies("nobody00"))
  }

  @Test
  fun `the address is on a notification only with several accounts`() {
    val one = BackgroundConfig.fromJson(JSONObject().put("enabled", true).put("accounts", JSONArray().put(account("abcd1234", "a@x"))))
    assertNull(one.labelFor("abcd1234"))
    val two = BackgroundConfig.fromJson(JSONObject().put("enabled", true).put("accounts", JSONArray().put(account("abcd1234", "a@x")).put(account("work9999", "b@x"))))
    assertEquals("b@x", two.labelFor("work9999"))
  }

  @Test
  fun `malformed accounts are dropped and no account means off`() {
    val config = BackgroundConfig.fromJson(
      JSONObject().put("enabled", true).put("activeAccount", "../etc")
        .put("accounts", JSONArray().put(account("../etc", "x")).put(account("AB", "y")).put(JSONObject())),
    )
    assertFalse(config.enabled)
    assertTrue(config.accounts.isEmpty())
    assertNull(config.activeAccount)
    assertEquals(BackgroundConfig.OFF, BackgroundConfig.fromJson(null))
  }

  @Test
  fun `turned off stays off even with accounts`() {
    val config = BackgroundConfig.fromJson(JSONObject().put("enabled", false).put("accounts", JSONArray().put(account("abcd1234", "a@x"))))
    assertFalse(config.enabled)
  }

  @Test
  fun `the address and the Gmail-listener switch survive, and the switch is off without sync`() {
    val acc = account("abcd1234", null).put("address", " Me@Example.com ")
    val on = BackgroundConfig.fromJson(JSONObject().put("enabled", true).put("gmailListener", true).put("accounts", JSONArray().put(acc)))
    assertTrue(on.gmailListener)
    assertEquals("me@example.com", on.accounts[0].address)
    assertEquals(on, BackgroundConfig.fromJson(on.toJson()))
    val off = BackgroundConfig.fromJson(JSONObject().put("enabled", false).put("gmailListener", true).put("accounts", JSONArray().put(acc)))
    assertFalse(off.gmailListener)
    // An older web layer sends neither: no address, switch off.
    val old = BackgroundConfig.fromJson(JSONObject().put("enabled", true).put("accounts", JSONArray().put(account("abcd1234", "a@x"))))
    assertFalse(old.gmailListener)
    assertNull(old.accounts[0].address)
    val bad = BackgroundConfig.fromJson(JSONObject().put("enabled", true).put("accounts", JSONArray().put(account("abcd1234", null).put("address", "nope"))))
    assertNull(bad.accounts[0].address)
  }
}

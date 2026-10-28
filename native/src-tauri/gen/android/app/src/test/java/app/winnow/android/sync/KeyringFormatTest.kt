package app.winnow.android.sync

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pins `android-native-keyring-store` 1.x's layout (its `by_store` vault and `crypto.rs`),
 * as `secrets.rs` uses it, so a crate upgrade that changes it fails here rather than on a phone.
 */
class KeyringFormatTest {
  @Test
  fun `an entry is user, BOM-wrapped at sign, service`() {
    assertEquals("gmail.tokens@abcd1234\uFEFF@\uFEFFapp.winnow.desktop", KeyringFormat.entryKey(KeyringFormat.tokensName("abcd1234")))
    assertEquals("google.oauth-client\uFEFF@\uFEFFapp.winnow.desktop", KeyringFormat.entryKey(KeyringFormat.CLIENT_NAME))
    assertEquals("keyring-default", KeyringFormat.FILE)
    assertEquals("keyring-default", KeyringFormat.KEY_ALIAS)
  }

  @Test
  fun `a value is the IV length, the IV, then ciphertext and tag`() {
    val iv = ByteArray(12) { it.toByte() }
    val ct = ByteArray(20) { (100 + it).toByte() }
    val (gotIv, gotCt) = KeyringFormat.split(byteArrayOf(12) + iv + ct)!!
    assertArrayEquals(iv, gotIv)
    assertArrayEquals(ct, gotCt)
  }

  @Test
  fun `anything else is not a value`() {
    assertNull(KeyringFormat.split(ByteArray(0)))
    assertNull(KeyringFormat.split(byteArrayOf(16) + ByteArray(40)))
    // Shorter than an IV plus a GCM tag.
    assertNull(KeyringFormat.split(byteArrayOf(12) + ByteArray(12) + ByteArray(15)))
  }
}

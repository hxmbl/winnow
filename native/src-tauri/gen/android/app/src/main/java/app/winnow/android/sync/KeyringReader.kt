package app.winnow.android.sync

import android.content.Context
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Reads one secret the Rust keychain wrote, in the layout [KeyringFormat] describes. Never writes. */
class KeyringReader(private val context: Context) {
  /** The secret's text, or null when there is none or it cannot be read. */
  fun get(name: String): String? {
    return try {
      val prefs = context.getSharedPreferences(KeyringFormat.FILE, Context.MODE_PRIVATE)
      val b64 = prefs.getString(KeyringFormat.entryKey(name), null) ?: return null
      val (iv, ciphertext) = KeyringFormat.split(Base64.decode(b64, Base64.DEFAULT)) ?: return null
      val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      val key = store.getKey(KeyringFormat.KEY_ALIAS, null) as? SecretKey ?: return null
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(KeyringFormat.TAG_BITS, iv))
      String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    } catch (_: Exception) {
      null
    }
  }
}

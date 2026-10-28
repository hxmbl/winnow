package app.winnow.android.sync

/**
 * Where `android-native-keyring-store` 1.x keeps a secret, and how it is wrapped, so the
 * background service can *read* the tokens the Rust side wrote without Rust running.
 *
 * The service may run in a process Android started on its own (boot, or after killing
 * the app), with no activity, so no Tauri, and no `ndk-context` for the Rust keyring to
 * find. The store's format is plain Android, though, and the Keystore key belongs to the
 * app, not to Rust:
 *
 * - SharedPreferences file `keyring-default` (the default store's `filename`);
 * - entry key `<user><divider><service>`, the divider being U+FEFF @ U+FEFF, the user the
 *   secret's name (`gmail.tokens@<id>`) and the service `app.winnow.desktop`
 *   (`SERVICE` in `secrets.rs`);
 * - value: standard base64 of `[12][12-byte IV][AES-GCM ciphertext + 128-bit tag]`;
 * - key: AndroidKeyStore alias `keyring-default`.
 *
 * Read only. Writing stays with the web layer through Rust, so there is one writer. A
 * crate upgrade that changed the format would make [KeyringReader.get] answer null,
 * which the service reports as "sign in again" rather than guessing; `KeyringFormatTest`
 * pins the layout.
 */
object KeyringFormat {
  const val FILE = "keyring-default"
  const val KEY_ALIAS = "keyring-default"
  const val SERVICE = "app.winnow.desktop"
  const val DIVIDER = "\uFEFF@\uFEFF"
  const val IV_LEN = 12
  const val TAG_BITS = 128

  /** The SharedPreferences key for a secret named `name`. */
  fun entryKey(name: String): String = "$name$DIVIDER$SERVICE"

  /** The keychain name of an account's tokens (`tokenSecretName` in `accounts.ts`). */
  fun tokensName(account: String): String = "gmail.tokens@$account"

  const val CLIENT_NAME = "google.oauth-client"

  /** Split a stored value into (iv, ciphertext with its tag), or null when it is not one. */
  fun split(data: ByteArray): Pair<ByteArray, ByteArray>? {
    if (data.isEmpty() || data[0].toInt() != IV_LEN) return null
    if (data.size < 1 + IV_LEN + TAG_BITS / 8) return null
    return Pair(data.copyOfRange(1, 1 + IV_LEN), data.copyOfRange(1 + IV_LEN, data.size))
  }
}

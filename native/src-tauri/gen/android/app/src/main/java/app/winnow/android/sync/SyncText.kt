package app.winnow.android.sync

/** The background service's words and Android-version rules, as plain Kotlin (`SyncTextTest`). */
object SyncText {
  /** `ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE`, the value Android 14 (API 34) gave it. */
  const val TYPE_SPECIAL_USE = 0x40000000

  /**
   * The type `startForeground` is given: `specialUse` from Android 14, where a type is
   * required and must match the manifest; none before, where the manifest's type is
   * not one the system knows and a plain foreground service is what runs.
   */
  fun serviceType(sdk: Int): Int = if (sdk >= 34) TYPE_SPECIAL_USE else 0

  /**
   * The persistent notification: what it is doing, and when an account needs signing in
   * again, which one (Google refused its refresh token, so its mail is not being checked).
   */
  fun persistent(needSignIn: List<String>): Pair<String, String> = when (needSignIn.size) {
    0 -> "Checking for new mail" to "Winnow checks about once a minute while it's closed."
    1 -> "Sign in again to get new mail" to "Winnow can't check ${needSignIn[0]} until you sign in again."
    else -> "Sign in again to get new mail" to "Winnow can't check ${needSignIn.size} accounts until you sign in again."
  }
}

package app.winnow.android.signin

import java.security.MessageDigest

/**
 * The decisions behind native sign-in that need no Android framework, so plain JVM
 * unit tests can pin them (`src/test/.../SignInLogicTest.kt`).
 */
object SignInLogic {
  /**
   * Why a sign-in produced no code, in the words the web layer reads
   * (`web/src/platform/nativeGoogle.ts`). Every one but [CANCELLED] sends the sign-in
   * to the browser.
   */
  const val CANCELLED = "cancelled"
  const val NO_PLAY_SERVICES = "no_play_services"
  const val DEVELOPER_ERROR = "developer_error"
  const val NETWORK = "network"
  const val FAILED = "failed"

  // Google Play services' status codes (CommonStatusCodes / GoogleSignInStatusCodes),
  // as literals so this file needs no Play services classes.
  private const val STATUS_NETWORK_ERROR = 7
  private const val STATUS_DEVELOPER_ERROR = 10
  private const val STATUS_CANCELED = 16
  private const val STATUS_SIGN_IN_CANCELLED = 12501
  private const val STATUS_API_NOT_CONNECTED = 17
  private const val STATUS_SERVICE_MISSING = 1
  private const val STATUS_SERVICE_VERSION_UPDATE_REQUIRED = 2
  private const val STATUS_SERVICE_DISABLED = 3

  /** The reason for a failed Play services call, from its `ApiException` status code. */
  fun reasonForStatus(statusCode: Int): String = when (statusCode) {
    STATUS_CANCELED, STATUS_SIGN_IN_CANCELLED -> CANCELLED
    // DEVELOPER_ERROR is Google refusing the app: no Android client in the
    // serverClientId's project matches this package name and signing certificate.
    STATUS_DEVELOPER_ERROR -> DEVELOPER_ERROR
    STATUS_NETWORK_ERROR -> NETWORK
    STATUS_SERVICE_MISSING, STATUS_SERVICE_VERSION_UPDATE_REQUIRED, STATUS_SERVICE_DISABLED,
    STATUS_API_NOT_CONNECTED -> NO_PLAY_SERVICES
    else -> FAILED
  }

  /** A certificate's fingerprint as Android and the Cloud Console write it: `AA:BB:…`. */
  fun fingerprint(certificate: ByteArray, algorithm: String = "SHA-1"): String =
    MessageDigest.getInstance(algorithm).digest(certificate).joinToString(":") { "%02X".format(it) }

  /**
   * The scopes worth asking for: Google API scopes only, without duplicates, in order.
   * Rust checked them already; this keeps the plugin honest on its own.
   */
  fun cleanScopes(scopes: Array<String>?): List<String> =
    (scopes ?: emptyArray())
      .map { it.trim() }
      .filter { it.startsWith("https://www.googleapis.com/auth/") && !it.contains(' ') }
      .distinct()

  /** Whether a sign-in tab may open this URL: Google's consent page over https only. */
  fun isSignInUrl(url: String?): Boolean {
    if (url == null) return false
    val match = Regex("^https://([^/?#:]+)(?::\\d+)?(?:[/?#].*)?$").find(url) ?: return false
    return match.groupValues[1].equals("accounts.google.com", ignoreCase = true)
  }
}

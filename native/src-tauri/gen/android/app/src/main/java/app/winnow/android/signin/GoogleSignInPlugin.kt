package app.winnow.android.signin

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.browser.customtabs.CustomTabsIntent
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope

@InvokeArg
class AuthorizeArgs {
  var serverClientId: String = ""
  var scopes: Array<String> = emptyArray()
}

@InvokeArg
class OpenTabArgs {
  var url: String = ""
}

/**
 * Native Google sign-in, for `src/google_signin.rs` (registered there as `google-signin`).
 *
 * - `authorize`: Google Play services' `AuthorizationClient` asks for the Gmail scopes
 *   with offline access for `serverClientId` (the user's Web application client), and
 *   hands back the server auth code. The web layer exchanges it with that client's
 *   secret for a refresh token. Google issues the code only when the same Cloud project
 *   has an Android client for this package name and signing certificate; otherwise it
 *   answers DEVELOPER_ERROR.
 * - `signingInfo`: the package name and the running APK's SHA-1, for the setup guide.
 * - `openTab`: Google's consent page in a Custom Tab, for the browser fallback, with
 *   [SignInKeepAliveService] started first so the loopback listener can answer.
 * - `endKeepAlive`: stop that service once the sign-in is over.
 *
 * Every command resolves; none rejects except `openTab`. A sign-in that cannot finish
 * resolves `{ kind: "unavailable", reason, detail }` and the web layer opens the browser
 * flow instead, so nothing here may throw past its own catch.
 */
@TauriPlugin
class GoogleSignInPlugin(private val activity: Activity) : Plugin(activity) {

  @Command
  fun signingInfo(invoke: Invoke) {
    val result = JSObject()
    result.put("packageName", activity.packageName)
    signingSha1()?.let { result.put("sha1", it) }
    result.put("playServices", playServicesAvailable())
    invoke.resolve(result)
  }

  @Command
  fun authorize(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(AuthorizeArgs::class.java)
    } catch (e: Exception) {
      unavailable(invoke, SignInLogic.FAILED, "unreadable arguments")
      return
    }
    val scopes = SignInLogic.cleanScopes(args.scopes)
    if (args.serverClientId.isBlank() || scopes.isEmpty()) {
      unavailable(invoke, SignInLogic.FAILED, "no client or no scopes")
      return
    }
    if (!playServicesAvailable()) {
      unavailable(invoke, SignInLogic.NO_PLAY_SERVICES, "Google Play services is not available")
      return
    }

    try {
      val request = AuthorizationRequest.builder()
        .setRequestedScopes(scopes.map { Scope(it) })
        // `true`: always issue a code that exchanges for a refresh token, even when this
        // account granted these scopes before. Winnow has no server to keep one.
        .requestOfflineAccess(args.serverClientId, true)
        .build()
      Identity.getAuthorizationClient(activity)
        .authorize(request)
        .addOnSuccessListener { result ->
          val pending = result.pendingIntent
          if (result.hasResolution() && pending != null) {
            // The account picker and consent screen. The answer comes back to
            // `authorizeResult`.
            startIntentSenderForResult(
              invoke,
              IntentSenderRequest.Builder(pending.intentSender).build(),
              "authorizeResult"
            )
          } else {
            finish(invoke, result)
          }
        }
        .addOnFailureListener { error -> fail(invoke, error) }
    } catch (e: Exception) {
      fail(invoke, e)
    }
  }

  @ActivityCallback
  fun authorizeResult(invoke: Invoke, result: ActivityResult) {
    val data = result.data
    if (data == null) {
      // Closed without an answer: the user backed out of the sheet.
      if (result.resultCode == Activity.RESULT_CANCELED) cancelled(invoke)
      else unavailable(invoke, SignInLogic.FAILED, "the account sheet returned nothing")
      return
    }
    try {
      finish(invoke, Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(data))
    } catch (e: Exception) {
      fail(invoke, e)
    }
  }

  @Command
  fun openTab(invoke: Invoke) {
    val url = try {
      invoke.parseArgs(OpenTabArgs::class.java).url
    } catch (e: Exception) {
      invoke.reject("unreadable arguments")
      return
    }
    if (!SignInLogic.isSignInUrl(url)) {
      invoke.reject("a sign-in tab opens Google's consent page only")
      return
    }
    // Keep Winnow running while the tab is in front, or Android may freeze it and the
    // loopback listener cannot answer Google's redirect (SignInKeepAliveService).
    val keptAlive = SignInKeepAliveService.start(activity)
    try {
      // Opened from the activity, without NEW_TASK, so the tab sits in Winnow's own task:
      // the success page's winnow://signed-in link brings the single-task activity back
      // and closes the tab. With no Custom Tabs browser installed this opens a plain one.
      CustomTabsIntent.Builder()
        .setShowTitle(true)
        .setUrlBarHidingEnabled(false)
        .build()
        .launchUrl(activity, Uri.parse(url))
      val answer = JSObject()
      answer.put("keptAlive", keptAlive)
      answer.put("keepAlive", SignInKeepAliveService.state)
      invoke.resolve(answer)
    } catch (e: ActivityNotFoundException) {
      SignInKeepAliveService.stop(activity)
      invoke.reject("no browser can open the sign-in page")
    } catch (e: Exception) {
      SignInKeepAliveService.stop(activity)
      invoke.reject(e.message ?: "the sign-in page could not be opened")
    }
  }

  /** The sign-in finished, timed out or was cancelled: let Android freeze us again. */
  @Command
  fun endKeepAlive(invoke: Invoke) {
    SignInKeepAliveService.stop(activity)
    val answer = JSObject()
    answer.put("keepAlive", SignInKeepAliveService.state)
    invoke.resolve(answer)
  }

  private fun finish(invoke: Invoke, result: AuthorizationResult) {
    val code = result.serverAuthCode
    if (code.isNullOrBlank()) {
      unavailable(invoke, SignInLogic.FAILED, "Google returned no authorization code")
      return
    }
    val answer = JSObject()
    answer.put("kind", "code")
    answer.put("code", code)
    answer.put("grantedScopes", JSArray(result.grantedScopes.toList()))
    invoke.resolve(answer)
  }

  private fun fail(invoke: Invoke, error: Exception) {
    if (error is ApiException) {
      val reason = SignInLogic.reasonForStatus(error.statusCode)
      if (reason == SignInLogic.CANCELLED) cancelled(invoke)
      else unavailable(invoke, reason, "status ${error.statusCode}")
      return
    }
    unavailable(invoke, SignInLogic.FAILED, error.javaClass.simpleName)
  }

  private fun cancelled(invoke: Invoke) {
    val answer = JSObject()
    answer.put("kind", "cancelled")
    invoke.resolve(answer)
  }

  private fun unavailable(invoke: Invoke, reason: String, detail: String) {
    val answer = JSObject()
    answer.put("kind", "unavailable")
    answer.put("reason", reason)
    answer.put("detail", detail)
    invoke.resolve(answer)
  }

  private fun playServicesAvailable(): Boolean = try {
    GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(activity) == ConnectionResult.SUCCESS
  } catch (e: Exception) {
    false
  }

  /** The SHA-1 of the certificate this APK is signed with now, or null. */
  private fun signingSha1(): String? = try {
    val manager = activity.packageManager
    val certificate: ByteArray? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val info = manager.getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
      // The current signer(s), whether or not the key was rotated.
      info.signingInfo?.apkContentsSigners?.firstOrNull()?.toByteArray()
    } else {
      @Suppress("DEPRECATION")
      val info = manager.getPackageInfo(activity.packageName, PackageManager.GET_SIGNATURES)
      @Suppress("DEPRECATION")
      info.signatures?.firstOrNull()?.toByteArray()
    }
    certificate?.let { SignInLogic.fingerprint(it) }
  } catch (e: Exception) {
    null
  }
}

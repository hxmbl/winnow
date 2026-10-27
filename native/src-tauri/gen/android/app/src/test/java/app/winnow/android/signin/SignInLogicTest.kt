package app.winnow.android.signin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SignInLogicTest {
  @Test
  fun statusCodesMapToTheReasonsTheWebLayerReads() {
    assertEquals(SignInLogic.CANCELLED, SignInLogic.reasonForStatus(16))
    assertEquals(SignInLogic.CANCELLED, SignInLogic.reasonForStatus(12501))
    assertEquals(SignInLogic.DEVELOPER_ERROR, SignInLogic.reasonForStatus(10))
    assertEquals(SignInLogic.NETWORK, SignInLogic.reasonForStatus(7))
    assertEquals(SignInLogic.NO_PLAY_SERVICES, SignInLogic.reasonForStatus(1))
    assertEquals(SignInLogic.NO_PLAY_SERVICES, SignInLogic.reasonForStatus(2))
    assertEquals(SignInLogic.NO_PLAY_SERVICES, SignInLogic.reasonForStatus(3))
    assertEquals(SignInLogic.FAILED, SignInLogic.reasonForStatus(8))
    assertEquals(SignInLogic.FAILED, SignInLogic.reasonForStatus(-1))
  }

  @Test
  fun aFingerprintIsUpperCaseHexPairsJoinedByColons() {
    // SHA-1 of the ASCII bytes "abc", a published test vector.
    assertEquals(
      "A9:99:3E:36:47:06:81:6A:BA:3E:25:71:78:50:C2:6C:9C:D0:D8:9D",
      SignInLogic.fingerprint("abc".toByteArray(Charsets.US_ASCII))
    )
  }

  @Test
  fun onlyGoogleApiScopesAreAskedFor() {
    val gmail = "https://www.googleapis.com/auth/gmail.modify"
    assertEquals(
      listOf(gmail),
      SignInLogic.cleanScopes(arrayOf(" $gmail ", gmail, "openid", "https://evil.example/auth/x", "https://www.googleapis.com/auth/a b"))
    )
    assertEquals(emptyList<String>(), SignInLogic.cleanScopes(null))
  }

  @Test
  fun aSignInTabOpensGoogleConsentOnly() {
    assertTrue(SignInLogic.isSignInUrl("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"))
    assertTrue(SignInLogic.isSignInUrl("https://accounts.google.com"))
    assertFalse(SignInLogic.isSignInUrl("http://accounts.google.com/o/oauth2/v2/auth"))
    assertFalse(SignInLogic.isSignInUrl("https://accounts.google.com.evil.example/"))
    assertFalse(SignInLogic.isSignInUrl("https://evil.example/?u=https://accounts.google.com/"))
    assertFalse(SignInLogic.isSignInUrl("https://user@evil.example/"))
    assertFalse(SignInLogic.isSignInUrl("winnow://signed-in"))
    assertFalse(SignInLogic.isSignInUrl(null))
  }

  @Test
  fun theSignInKeepAliveIsAShortServiceFromAndroid14() {
    assertEquals(2048, SignInLogic.keepAliveServiceType(34))
    assertEquals(2048, SignInLogic.keepAliveServiceType(35))
    assertEquals(0, SignInLogic.keepAliveServiceType(33))
    assertEquals(0, SignInLogic.keepAliveServiceType(24))
  }
}

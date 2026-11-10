package app.winnow.android

import android.util.Log

/**
 * When [MainActivity] should ask its WebView to draw again (STRM-568).
 *
 * A link from a message opens in the browser or a Custom Tab, which covers Winnow and
 * stops its activity: Android drops the window's surface, and the WebView keeps only
 * what it last drew. Back from the browser, the WebView resumes but nothing asks it for
 * a new frame, and Winnow's screens are still (no animation is running), so the window
 * stayed blank until a tap made the page draw. The activity therefore invalidates the
 * WebView once it is back in front: on resume and again when the window has focus,
 * since the surface may not be ready at the first.
 *
 * Only after a stop. A plain pause (a permission dialog, the notification shade) keeps
 * the surface and its picture, so there is nothing to redraw. Pure Kotlin, so the JVM
 * tests can pin it.
 */
class ResumeRepaint {
  private var stopped = false

  companion object {
    private const val TAG = "STRM-584"
  }

  /** The activity went out of sight (`onStop`). */
  fun onStop() {
    Log.d(TAG, "ResumeRepaint.onStop: stopped = true")
    stopped = true
  }

  /** `onResume`: true when the WebView should be invalidated now. */
  fun onResume(): Boolean {
    Log.d(TAG, "ResumeRepaint.onResume: stopped = $stopped, shouldRedraw = $stopped")
    return stopped
  }

  /**
   * `onWindowFocusChanged`: true when the WebView should be invalidated now. Focus back
   * is the last step of coming back to the front, so it ends the redraw.
   */
  fun onFocus(hasFocus: Boolean): Boolean {
    val shouldRedraw = hasFocus && stopped
    if (shouldRedraw) {
      Log.d(TAG, "ResumeRepaint.onFocus: hasFocus = $hasFocus, stopped = $stopped, clearing stopped flag")
      stopped = false
    } else {
      Log.d(TAG, "ResumeRepaint.onFocus: hasFocus = $hasFocus, stopped = $stopped, shouldRedraw = $shouldRedraw")
    }
    return shouldRedraw
  }
}

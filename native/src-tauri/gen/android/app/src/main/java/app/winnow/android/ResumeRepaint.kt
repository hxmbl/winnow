package app.winnow.android

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
class ResumeRepaint(
  private val log: (String) -> Unit = {},
) {
  private var stopped = false

  fun onStop() {
    log("ResumeRepaint.onStop: stopped = true")
    stopped = true
  }

  fun onResume(): Boolean {
    log("ResumeRepaint.onResume: stopped = $stopped")
    return stopped
  }

  fun onFocus(hasFocus: Boolean): Boolean {
    val shouldRedraw = hasFocus && stopped

    if (shouldRedraw) {
      log("ResumeRepaint.onFocus: clearing stopped flag")
      stopped = false
    } else {
      log("ResumeRepaint.onFocus: hasFocus = $hasFocus, stopped = $stopped")
    }

    return shouldRedraw
  }
}

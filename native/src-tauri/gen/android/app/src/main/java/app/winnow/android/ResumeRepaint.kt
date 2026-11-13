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
 * After any way out of sight, not only a stop (STRM-568 return paths): Back or Recents
 * from the browser does not always stop the activity first, focus can come back before
 * `onResume` or not come back at all, and `onRestart` can arrive without a recorded stop.
 * So a pause, a stop or a restart marks the activity away; `onResume` and focus regained
 * each redraw while it is away, and the redraw ends only once it is both resumed and
 * focused. An extra invalidate costs one frame, so erring towards redrawing is fine. A
 * first start has nothing to come back to and does not redraw. Pure Kotlin, so the JVM
 * tests can pin it.
 */
class ResumeRepaint(
  private val log: (String) -> Unit = {},
) {
  private var away = false
  private var resumed = false

  /** `onPause`: out of front, possibly without a stop to follow. */
  fun onPause() {
    log("ResumeRepaint.onPause: away = true")
    away = true
    resumed = false
  }

  fun onStop() {
    log("ResumeRepaint.onStop: away = true")
    away = true
    resumed = false
  }

  /** `onRestart` only follows a stop, so it always asks for a redraw. */
  fun onRestart(): Boolean {
    log("ResumeRepaint.onRestart: away = true")
    away = true
    return true
  }

  fun onResume(): Boolean {
    log("ResumeRepaint.onResume: away = $away")
    resumed = true
    return away
  }

  fun onFocus(hasFocus: Boolean): Boolean {
    val shouldRedraw = hasFocus && away
    if (shouldRedraw && resumed) {
      log("ResumeRepaint.onFocus: resumed and focused, clearing away")
      away = false
    } else {
      log("ResumeRepaint.onFocus: hasFocus = $hasFocus, away = $away, resumed = $resumed")
    }
    return shouldRedraw
  }
}

package app.winnow.android

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.winnow.android.notify.LaunchLinks

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // A notification's tap that had to start this activity: kept for the web layer to
    // take once it listens (notify/LaunchLinks.kt explains why the deep-link plugin
    // alone misses it). Before super, which starts the webview loading.
    LaunchLinks.offerLaunch(intent?.action, intent?.dataString, intent?.flags ?: 0, savedInstanceState != null)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Edge-to-edge is forced on Android 15+, and the WebView does not report the
    // system bars through CSS `env(safe-area-inset-*)`, so the app's top bar sat
    // under the status bar and its bottom dock under the gesture bar. Padding the
    // content view by the bars, the display cutout and the keyboard keeps the whole
    // web UI inside the visible area, and resizes it when the keyboard opens.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  /**
   * A tap while this activity exists (`singleTask`). The deep-link plugin hears it through
   * `super` and the web layer opens the message; it is kept as well for the case where
   * Rust is not up yet to pass it on (the process was just restarted for this tap).
   */
  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    LaunchLinks.offerNew(intent.action, intent.dataString)
    super.onNewIntent(intent)
  }
}

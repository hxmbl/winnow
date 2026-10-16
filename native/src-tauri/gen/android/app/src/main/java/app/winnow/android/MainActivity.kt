package app.winnow.android

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
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
}

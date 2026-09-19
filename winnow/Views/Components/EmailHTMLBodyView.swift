import AppKit
import SwiftUI
import WebKit

/// Renders an email's `text/html` body with the platform web view, keeping the
/// native reader chrome (sender, subject, badges, composer) around it.
///
/// The page is sized to its content so the surrounding `ScrollView` scrolls as
/// one surface — no nested scrollbars for normal-length mail. Scroll-wheel
/// events are forwarded through the web view to that `ScrollView`
/// (`ScrollThroughWebView`), so the reader behaves like a single page.
///
/// SECURITY MODEL (external email HTML is hostile input):
/// - JavaScript is disabled for the page (`allowsContentJavaScript = false`).
///   The height measurement below uses app-driven `evaluateJavaScript`, which
///   is separate from page scripting and still runs.
/// - Remote content is blocked by default via a `Content-Security-Policy` meta
///   (`loadRemoteContent` in Settings → Mail), so tracking pixels and remote
///   images/CSS/fonts never reach the network. When the user opts in, they do.
/// - The web view never navigates away from the message. Link clicks and
///   `target="_blank"` requests are forwarded to the user's default browser
///   for `http(s)` only; everything else (meta-refresh, redirects, form
///   submits, other schemes) is dropped without leaving the app.
/// - WKWebView renders in the OS's own sandboxed WebContent process, so a
///   malicious message cannot reach the app's files or Keychain.
struct EmailHTMLBodyView: View {
    let html: String

    /// Mirrors the persisted setting so toggling it re-renders the loaded page.
    @AppStorage(WinnowStore.loadRemoteContentKey) private var loadRemoteContent = false

    /// Measured content height; starts at a floor so a message that measures
    /// slowly still has a readable canvas.
    @State private var height: CGFloat = 180

    var body: some View {
        WebKitEmailBodyView(html: html, height: $height, loadRemoteContent: loadRemoteContent)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .frame(height: max(height, 180))
            .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Color.winnowBorder.opacity(0.5), lineWidth: 1)
            )
    }
}

/// The `NSViewRepresentable` bridge. `/height` is written back as the page's
/// rendered height so SwiftUI can lay the body out inside the reader's scroll.
private struct WebKitEmailBodyView: NSViewRepresentable {
    var html: String
    @Binding var height: CGFloat
    var loadRemoteContent: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        // No audible autoplay from a marketing email.
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        let webView = ScrollThroughWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        context.coordinator.attach(webView, html: html)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.attach(webView, html: html)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private var parent: WebKitEmailBodyView
        private weak var webView: WKWebView?
        private var loadedHTML: String?
        private var loadedAllowsRemoteContent: Bool?
        private var heightTask: Task<Void, Never>?

        init(_ parent: WebKitEmailBodyView) {
            self.parent = parent
        }

        /// Loads the HTML once per document — SwiftUI re-runs `updateNSView`
        /// whenever the height binding changes, and re-loading on every update
        /// would reset the page in a loop. `loadedHTML` holds the *raw* source
        /// so re-highlighting never happens just because the binding ticked.
        func attach(_ webView: WKWebView, html: String) {
            self.webView = webView
            let allowsRemoteContent = parent.loadRemoteContent
            guard html != loadedHTML || allowsRemoteContent != loadedAllowsRemoteContent else { return }
            loadedHTML = html
            loadedAllowsRemoteContent = allowsRemoteContent
            // STO-136: page scripting is disabled (security model), so syntax
            // highlighting is done here in Swift before the document loads.
            let highlighted = CodeHighlighting.highlightCodeBlocks(in: html)
            let rendered = allowsRemoteContent
                ? highlighted
                : Self.blockingRemoteContent(in: highlighted)
            webView.loadHTMLString(rendered, baseURL: nil)
        }

        /// Prepends a restrictive `Content-Security-Policy` meta so the page
        /// cannot open a network connection — no tracking pixels, remote
        /// images, CSS, fonts or `meta`-refresh — even though the web view
        /// would otherwise fetch `http(s)` subresources. Inline styles are
        /// allowed so the message keeps its own formatting.
        nonisolated static func blockingRemoteContent(in html: String) -> String {
            let meta = """
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; \
            img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; \
            script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; \
            form-action 'none'; base-uri 'none'">
            """
            if let open = html.range(of: "<head", options: .caseInsensitive),
               let end = html[open.lowerBound...].firstIndex(of: ">") {
                let after = html.index(after: end)
                return html.replacingCharacters(in: after..<after, with: meta)
            }
            if let open = html.range(of: "<html", options: .caseInsensitive),
               let end = html[open.lowerBound...].firstIndex(of: ">") {
                let after = html.index(after: end)
                return html.replacingCharacters(in: after..<after, with: "<head>\(meta)</head>")
            }
            return meta + html
        }

        // MARK: - Navigation sandbox

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            switch navigationAction.navigationType {
            case .linkActivated:
                Self.openExternally(navigationAction.request.url)
                decisionHandler(.cancel)

            case .other:
                // The initial loadHTMLString document (the email itself) is an
                // `about:blank` request — let it through. Anything else under
                // `.other` is meta-refresh / a redirect leaving the message:
                // cancel it rather than handing it to the browser, so a
                // message cannot silently open a URL or leak a read receipt.
                guard let url = navigationAction.request.url,
                      url.absoluteString == "about:blank" else {
                    decisionHandler(.cancel)
                    return
                }
                decisionHandler(.allow)

            case .backForward, .reload, .formSubmitted, .formResubmitted:
                decisionHandler(.cancel)

            @unknown default:
                decisionHandler(.cancel)
            }
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            Self.openExternally(navigationAction.request.url)
            return nil
        }

        /// Only `http(s)` leaves the reader; `mailto:`, `tel:`, `data:`, etc.
        /// are dropped rather than handed to Launch Services.
        nonisolated private static func openExternally(_ url: URL?) {
            guard let url,
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https" else { return }
            NSWorkspace.shared.open(url)
        }

        // MARK: - Height autosizing

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            scheduleHeightUpdates()
        }

        /// Images commonly finish after `didFinish` and grow the page, so after
        /// each navigation completion we poll the rendered height briefly and
        /// stop once it stabilizes. App-driven `evaluateJavaScript` keeps
        /// working with page scripting disabled.
        private func scheduleHeightUpdates() {
            heightTask?.cancel()
            heightTask = Task { @MainActor in
                var last: CGFloat = 0
                var stableTicks = 0
                for _ in 0..<16 {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    guard let webView else { return }
                    guard let measured = await Self.measuredHeight(of: webView) else { continue }
                    if measured == last {
                        stableTicks += 1
                    } else {
                        stableTicks = 0
                    }
                    last = measured
                    applyHeight(measured)
                    if stableTicks >= 2 { return }
                }
            }
        }

        @MainActor private static func measuredHeight(of webView: WKWebView) async -> CGFloat? {
            let script = """
            Math.max(
              document.body.scrollHeight, document.documentElement.scrollHeight,
              document.body.offsetHeight, document.documentElement.offsetHeight,
              0
            )
            """
            guard let number = (try? await webView.evaluateJavaScript(script)) as? NSNumber,
                  number.doubleValue.isFinite else { return nil }
            return CGFloat(max(0, number.doubleValue))
        }

        private func applyHeight(_ height: CGFloat) {
            // Absurd fixed-height elements are hostile input, not layout intent —
            // cap so a pathological message can't balloon the reader card. Above
            // the cap the web view's own scrollers take over (content exceeds
            // frame), so nothing is actually cut off.
            let capped = min(height, 30_000)
            guard capped != parent.height else { return }
            parent.height = capped
        }
    }
}

/// A web view that lets scroll-wheel events pass through to the reader's own
/// `ScrollView`. The internal document view is sized to the content, so the
/// web view has nothing to scroll internally — yet its internal scroller still
/// swallows `scrollWheel` events, which would freeze the outer reader while
/// the cursor is over the message. Routing the event past that internal
/// scroller and into the first outer `NSScrollView` makes the message scroll
/// like the rest of the card.
private final class ScrollThroughWebView: WKWebView {
    override func scrollWheel(with event: NSEvent) {
        guard let outer = Self.outerScrollView(below: self) else {
            super.scrollWheel(with: event)
            return
        }
        outer.scrollWheel(with: event)
    }

    /// The first `NSScrollView` above us in the superview chain, skipping the
    /// web view's own internal scroller — i.e. the SwiftUI reader `ScrollView`.
    private static func outerScrollView(below view: NSView) -> NSScrollView? {
        var candidate = view.superview
        while let current = candidate {
            // WKWebView is not an NSScrollView on macOS, so the first scroll
            // view in the chain is the surrounding SwiftUI reader ScrollView.
            if let scrollView = current as? NSScrollView {
                return scrollView
            }
            candidate = current.superview
        }
        return nil
    }
}

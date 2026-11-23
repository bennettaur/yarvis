import SwiftUI
import WebKit

/// The full web UI, for the screens this app doesn't build natively. It signs
/// in on its own: the app's token isn't handed to the page.
struct WebUIView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(origin: url) }

    /// Keeps the window on the server's origin; other links open in the browser.
    final class Coordinator: NSObject, WKNavigationDelegate {
        let origin: URL

        init(origin: URL) {
            self.origin = origin
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            guard let target = action.request.url else { return decisionHandler(.cancel) }
            let sameOrigin = target.scheme == origin.scheme && target.host == origin.host && target.port == origin.port
            if sameOrigin || target.scheme == "about" || target.scheme == "blob" {
                decisionHandler(.allow)
            } else {
                // Only a link the user clicked leaves the app; a script or an
                // iframe navigating on its own is just stopped.
                let clicked = action.navigationType == .linkActivated && (action.targetFrame?.isMainFrame ?? true)
                if clicked, ["http", "https"].contains(target.scheme ?? "") { NSWorkspace.shared.open(target) }
                decisionHandler(.cancel)
            }
        }
    }
}

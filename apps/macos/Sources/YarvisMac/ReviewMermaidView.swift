import SwiftUI
import WebKit
import YarvisClient

/// Mermaid's script, copied into the app bundle by `scripts/make-app.sh`
/// when the repo's node_modules has it. Absent under `swift run`, and then
/// the diagram shows as source only.
@MainActor
enum MermaidScript {
    private static var cached: String??

    static var source: String? {
        if let cached { return cached }
        let script = Bundle.main.url(forResource: "mermaid.min", withExtension: "js")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
        cached = .some(script)
        return script
    }
}

/// Draws a Mermaid flowchart in a web view that holds only the page the app
/// built: no remote loads, no file access, no token, no windows opened by
/// script, no navigation. A link in the drawing opens in the browser through
/// `openWebLink`. Calls `onResult` with nil once drawn, or Mermaid's error.
struct ReviewMermaidView: NSViewRepresentable {
    let script: String
    let source: String
    let dark: Bool
    @Binding var height: CGFloat
    let onResult: (String?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.userContentController.add(WeakMessageHandler(context.coordinator), name: "mermaid")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        // Lets the tab's own background show behind the drawing.
        view.setValue(false, forKey: "drawsBackground")
        context.coordinator.load(view, script: script, source: source, dark: dark)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.load(view, script: script, source: source, dark: dark)
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "mermaid")
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: ReviewMermaidView
        private var loaded: (source: String, dark: Bool)?

        init(_ parent: ReviewMermaidView) {
            self.parent = parent
        }

        func load(_ view: WKWebView, script: String, source: String, dark: Bool) {
            if let loaded, loaded.source == source, loaded.dark == dark { return }
            loaded = (source, dark)
            view.loadHTMLString(mermaidPage(script: script, source: source, dark: dark), baseURL: nil)
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            if body["ok"] as? Bool == true {
                if let h = body["height"] as? Double, h > 0 { parent.height = h }
                parent.onResult(nil)
            } else {
                parent.onResult(body["error"] as? String ?? "unknown error")
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            // The page the app loaded arrives as about:blank; everything else stays out.
            if action.navigationType == .other, action.request.url?.absoluteString == "about:blank" {
                return decisionHandler(.allow)
            }
            if action.navigationType == .linkActivated, let url = action.request.url { openWebLink(url) }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            nil
        }
    }
}

/// The content controller keeps its handler alive; this breaks the cycle
/// back to the coordinator.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?

    init(_ target: any WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// A verification flow: title, explanation, the drawing when it can be
/// drawn, and its source.
struct ReviewFlowView: View {
    let flow: VerificationFlow
    @Environment(\.colorScheme) private var scheme
    @State private var height: CGFloat = 200
    @State private var drawError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(flow.title).font(.headline).textSelection(.enabled)
            if !flow.explanation.isEmpty {
                Text(flow.explanation).font(.callout).textSelection(.enabled)
            }
            if flow.tooLarge == true {
                Text("The diagram was too large to draw, so it was left out.").font(.callout).foregroundStyle(.orange)
            }
            if !flow.mermaid.isEmpty {
                drawing
                ReviewFold(title: "Mermaid source", initiallyOpen: MermaidScript.source == nil) {
                    Text(flow.mermaid).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
        }
    }

    @ViewBuilder private var drawing: some View {
        if !isDrawableFlowchart(flow.mermaid) {
            ReviewErrorText("The diagram isn't a flowchart, so it isn't drawn.")
        } else if let script = MermaidScript.source {
            if let drawError { ReviewErrorText("Couldn't draw the diagram: \(drawError)") }
            ReviewMermaidView(script: script, source: flow.mermaid, dark: scheme == .dark, height: $height) { drawError = $0 }
                .frame(height: height)
                .opacity(drawError == nil ? 1 : 0)
                .frame(height: drawError == nil ? height : 0)
        } else {
            Text("This build of the app doesn't include Mermaid, so the diagram shows as its source below.")
                .font(.callout).foregroundStyle(.secondary)
        }
    }
}

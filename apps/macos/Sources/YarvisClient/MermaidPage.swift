import CryptoKit
import Foundation

// The page that draws the verification report's Mermaid flowchart, and what
// the web view showing it may load.

/// Only flowcharts are drawn; any other diagram type Mermaid knows is a
/// bigger surface for model-written input to reach.
public func isDrawableFlowchart(_ source: String) -> Bool {
    source.range(of: #"^(flowchart|graph)\s"#, options: .regularExpression) != nil
}

/// The page that draws `source` with Mermaid. The library and the source go
/// in inline, so the page loads nothing. The CSP allows exactly those two
/// scripts by hash, so an event handler that got into the drawn SVG can't
/// run, plus inline styles, which Mermaid's SVG uses. The source travels as a
/// JSON string literal with `<` escaped, so it can't close the script element.
/// The page reports back through the `mermaid` message handler:
/// `{ok: true, height}` or `{ok: false, error}`.
public func mermaidPage(script: String, source: String, dark: Bool) -> String {
    let literal = (try? String(data: JSONEncoder().encode(source), encoding: .utf8)) ?? "\"\""
    let safeLiteral = literal.replacingOccurrences(of: "<", with: "\\u003c")
    // A `</script` inside the bundled library would end its element early.
    let library = script.replacingOccurrences(of: "</script", with: "<\\/script", options: .caseInsensitive)
    let theme = dark ? "dark" : "default"
    let render = """
    (async () => {
      const post = (m) => window.webkit.messageHandlers.mermaid.postMessage(m);
      try {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false,
          flowchart: { htmlLabels: false }, theme: "\(theme)" });
        const { svg } = await mermaid.render("flow", \(safeLiteral));
        document.getElementById("out").innerHTML = svg;
        post({ ok: true, height: document.body.scrollHeight });
      } catch (e) {
        post({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    """
    let hashes = [library, render].map { "'sha256-\(Data(SHA256.hash(data: Data($0.utf8))).base64EncodedString())'" }
    return """
    <!doctype html>
    <html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src \(hashes.joined(separator: " ")); style-src 'unsafe-inline'; img-src data:; font-src data:">
    <style>html,body{margin:0;background:transparent}#out svg{max-width:100%;height:auto}</style>
    </head><body><div id="out"></div>
    <script>\(library)</script>
    <script>\(render)</script>
    </body></html>
    """
}

/// What the Mermaid web view does with a navigation.
public enum MermaidNavigationDecision: Sendable, Equatable {
    case allow
    case cancel
}

/// Only the page the app loaded, which arrives as about:blank, is allowed.
/// Everything else is cancelled, link clicks included: a diagram needs no
/// links, and its text comes from the PR's code.
public func mermaidNavigation(isLinkClick: Bool, url: URL?) -> MermaidNavigationDecision {
    !isLinkClick && url?.absoluteString == "about:blank" ? .allow : .cancel
}

/// The drawing's height as the page reports it, kept to what a tab can show.
public func mermaidHeight(_ reported: Double) -> Double {
    guard reported.isFinite else { return 200 }
    return min(max(reported, 40), 4_000)
}

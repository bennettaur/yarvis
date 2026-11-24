import CryptoKit
import Foundation

// Layout for the guided review's flow graph, drawn natively, and the page
// that draws the verification report's Mermaid flowchart.

/// Each node's column: the longest hop count from a node nothing points at.
/// Edges are relaxed up to one pass per node, and no node goes past the last
/// column a graph this size could need, so a cycle stops rather than going
/// round. An edge with an end outside the graph is ignored.
public func nodeColumns(_ graph: PrGuideGraph) -> [String: Int] {
    var column = Dictionary(graph.nodes.map { ($0.id, 0) }, uniquingKeysWith: { a, _ in a })
    let lastColumn = graph.nodes.count - 1
    let edges = graph.edges.filter { column[$0.from] != nil && column[$0.to] != nil }
    for _ in graph.nodes {
        var moved = false
        for edge in edges {
            let next = column[edge.from]! + 1
            if next > column[edge.to]! && next <= lastColumn {
                column[edge.to] = next
                moved = true
            }
        }
        if !moved { break }
    }
    return column
}

public struct FlowGraphBox: Sendable, Equatable {
    /// The node's index in the graph; graph ids are model-written free text, so they aren't reused.
    public var index: Int
    public var x: Double
    public var y: Double
    public var title: String
    public var location: String?
    public var changed: Bool
}

public struct FlowGraphArrow: Sendable, Equatable {
    public var from: Int
    public var to: Int
    public var label: String
}

public struct FlowGraphLayout: Sendable, Equatable {
    public static let boxWidth = 240.0
    public static let boxHeight = 80.0
    static let columnGap = 140.0
    static let rowGap = 40.0

    public var boxes: [FlowGraphBox]
    public var arrows: [FlowGraphArrow]

    public var width: Double { (boxes.map(\.x).max() ?? 0) + Self.boxWidth }
    public var height: Double { (boxes.map(\.y).max() ?? 0) + Self.boxHeight }

    /// Boxes left to right by `nodeColumns`, stacked in graph order within a column.
    public init(_ graph: PrGuideGraph) {
        let columns = nodeColumns(graph)
        var rowsUsed: [Int: Int] = [:]
        var byId: [String: Int] = [:]
        boxes = graph.nodes.enumerated().map { index, node in
            let column = columns[node.id] ?? 0
            let row = rowsUsed[column, default: 0]
            rowsUsed[column] = row + 1
            if byId[node.id] == nil { byId[node.id] = index }
            let label = flowNodeLabel(node)
            return FlowGraphBox(index: index, x: Double(column) * (Self.boxWidth + Self.columnGap),
                                y: Double(row) * (Self.boxHeight + Self.rowGap), title: label.title,
                                location: label.location, changed: node.changed == true)
        }
        arrows = graph.edges.compactMap { edge in
            guard let from = byId[edge.from], let to = byId[edge.to] else { return nil }
            return FlowGraphArrow(from: from, to: to, label: oneLine(edge.kind))
        }
    }
}

/// Model-written text kept to one line, so a newline in a name can't push the
/// real path down and put a made-up one in its place.
func oneLine(_ text: String) -> String {
    text.unicodeScalars.split(whereSeparator: { $0.properties.isWhitespace || $0.properties.generalCategory == .control })
        .map { String(String.UnicodeScalarView($0)) }.joined(separator: " ")
}

/// A box's name (`id · kind`) and, under it, where the code is, so the reader
/// can check the model-written name against the path.
public func flowNodeLabel(_ node: PrGraphNode) -> (title: String, location: String?) {
    let file = node.file.map(oneLine).flatMap { $0.isEmpty ? nil : $0 }
    var lines: String?
    if let line = node.line, line != 0 {
        if let end = node.endLine, end > line { lines = "\(line)-\(end)" } else { lines = String(line) }
    }
    let location = file.map { f in lines.map { "\(f):\($0)" } ?? f }
    return ("\(oneLine(node.id)) · \(oneLine(node.kind))", location)
}

// MARK: Mermaid

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

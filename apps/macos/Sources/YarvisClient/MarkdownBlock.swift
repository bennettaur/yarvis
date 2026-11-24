import Foundation

/// Model output split into the blocks a client renders differently: fenced
/// code, headings, lists, tables, quotes, images, and text, which keeps its
/// inline markdown.
public indirect enum MarkdownBlock: Equatable, Sendable {
    public struct ListItem: Equatable, Sendable {
        public var text: String
        /// How far it's nested under the items before it, from 0.
        public var depth: Int

        public init(_ text: String, depth: Int = 0) {
            self.text = text
            self.depth = depth
        }
    }

    case text(String)
    case heading(String)
    case code(String)
    /// `start` is the first number of an ordered list, nil for bullets.
    case list(start: Int?, items: [ListItem])
    case quote([MarkdownBlock])
    case table(header: [String], rows: [[String]])
    /// A picture, shown by its alt text and never fetched.
    case image(alt: String)

    public static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var text: [String] = []
        let lines = source.components(separatedBy: "\n")
        func flushText() {
            let joined = text.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !joined.isEmpty { blocks.append(.text(joined)) }
            text = []
        }
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flushText()
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    code.append(lines[i])
                    i += 1
                }
                // An unclosed fence is still streaming; what's there shows as code.
                blocks.append(.code(code.joined(separator: "\n")))
                i += 1
            } else if let heading = headingText(line) {
                flushText()
                blocks.append(.heading(heading))
                i += 1
            } else if trimmed.hasPrefix(">") {
                flushText()
                var quoted: [String] = []
                while i < lines.count, case let t = lines[i].trimmingCharacters(in: .whitespaces), t.hasPrefix(">") {
                    var rest = t.dropFirst()
                    if rest.first == " " { rest = rest.dropFirst() }
                    quoted.append(String(rest))
                    i += 1
                }
                blocks.append(.quote(parse(quoted.joined(separator: "\n"))))
            } else if trimmed.hasPrefix("|"), i + 1 < lines.count, isTableDivider(lines[i + 1]) {
                flushText()
                let header = tableCells(line)
                var rows: [[String]] = []
                i += 2
                while i < lines.count, lines[i].contains("|"),
                      !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    var cells = tableCells(lines[i])
                    cells += Array(repeating: "", count: max(0, header.count - cells.count))
                    rows.append(Array(cells.prefix(header.count)))
                    i += 1
                }
                blocks.append(.table(header: header, rows: rows))
            } else if let marker = listMarker(line) {
                flushText()
                var items: [ListItem] = []
                let ordered = marker.number != nil
                while i < lines.count {
                    if let m = listMarker(lines[i]), (m.number != nil) == ordered || m.indent > 0 {
                        items.append(ListItem(m.text, depth: m.indent / 2))
                    } else if !items.isEmpty, lines[i].hasPrefix("  "),
                              !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                        // An indented line carries on the item above it.
                        items[items.count - 1].text += "\n" + lines[i].trimmingCharacters(in: .whitespaces)
                    } else {
                        break
                    }
                    i += 1
                }
                blocks.append(.list(start: marker.number, items: items))
            } else if let alt = standaloneImageAlt(trimmed) {
                flushText()
                blocks.append(.image(alt: alt))
                i += 1
            } else {
                text.append(line)
                i += 1
            }
        }
        flushText()
        return blocks
    }

    /// Replaces inline images with their alt text, so nothing is fetched and
    /// the picture still reads as one.
    public static func replacingImages(in text: String) -> String {
        let ns = text as NSString
        return inlineImagePattern.stringByReplacingMatches(
            in: text, range: NSRange(location: 0, length: ns.length), withTemplate: "_Image: $1_")
    }

    private static let inlineImagePattern = try! NSRegularExpression(pattern: #"!\[([^\]]*)\]\([^)]*\)"#)
    private static let standaloneImagePattern = try! NSRegularExpression(pattern: #"^!\[([^\]]*)\]\([^)]*\)$"#)

    private static func standaloneImageAlt(_ line: String) -> String? {
        let ns = line as NSString
        guard let m = standaloneImagePattern.firstMatch(in: line, range: NSRange(location: 0, length: ns.length))
        else { return nil }
        return ns.substring(with: m.range(at: 1))
    }

    private static func headingText(_ line: String) -> String? {
        guard line.hasPrefix("#"), let space = line.firstIndex(of: " "),
              line[..<space].allSatisfy({ $0 == "#" }) else { return nil }
        return String(line[line.index(after: space)...])
    }

    private struct Marker {
        var indent: Int
        var number: Int?
        var text: String
    }

    private static func listMarker(_ line: String) -> Marker? {
        let indent = line.prefix { $0 == " " }.count
        let rest = line.dropFirst(indent)
        if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
            let text = rest.dropFirst(2)
            // `---` and `***` are rules, not items.
            if text.allSatisfy({ $0 == first || $0 == " " }), !text.isEmpty { return nil }
            return Marker(indent: indent, number: nil, text: String(text))
        }
        let digits = rest.prefix { $0.isASCII && $0.isNumber }
        guard !digits.isEmpty, digits.count <= 9 else { return nil }
        let after = rest.dropFirst(digits.count)
        guard let punct = after.first, punct == "." || punct == ")", after.dropFirst().first == " " else { return nil }
        return Marker(indent: indent, number: Int(digits), text: String(after.dropFirst(2)))
    }

    private static func isTableDivider(_ line: String) -> Bool {
        let cells = tableCells(line)
        return !cells.isEmpty && cells.allSatisfy { cell in
            let core = cell.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            return !core.isEmpty && core.allSatisfy { $0 == "-" }
        }
    }

    private static func tableCells(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }
}

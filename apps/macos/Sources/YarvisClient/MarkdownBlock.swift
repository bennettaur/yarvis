import Foundation

/// Model output split into the blocks a client renders differently: fenced
/// code, headings, and text, which keeps its inline markdown.
public enum MarkdownBlock: Equatable, Sendable {
    case text(String)
    case heading(String)
    case code(String)

    public static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var text: [String] = []
        var code: [String]?
        func flushText() {
            let joined = text.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !joined.isEmpty { blocks.append(.text(joined)) }
            text = []
        }
        for line in source.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if let open = code {
                    blocks.append(.code(open.joined(separator: "\n")))
                    code = nil
                } else {
                    flushText()
                    code = []
                }
            } else if code != nil {
                code?.append(line)
            } else if line.hasPrefix("#"), let space = line.firstIndex(of: " "),
                      line[..<space].allSatisfy({ $0 == "#" }) {
                flushText()
                blocks.append(.heading(String(line[line.index(after: space)...])))
            } else {
                text.append(line)
            }
        }
        // An unclosed fence is still streaming; show what's there as code.
        if let open = code { blocks.append(.code(open.joined(separator: "\n"))) }
        flushText()
        return blocks
    }
}

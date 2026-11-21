import SwiftUI

/// Renders model output as markdown: fenced code blocks as monospaced boxes,
/// headings bold, and everything else through `AttributedString`'s inline
/// markdown, which keeps line breaks. Only http(s) links open.
struct MarkdownText: View {
    let blocks: [MarkdownBlock]

    init(_ source: String) {
        blocks = MarkdownBlock.parse(source)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let code):
                    ScrollView(.horizontal) {
                        Text(code).font(.callout.monospaced()).textSelection(.enabled).padding(8)
                    }
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
                case .heading(let text):
                    Text(inline(text)).font(.headline)
                case .text(let text):
                    Text(inline(text)).textSelection(.enabled)
                }
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            ["http", "https"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
        })
    }

    private func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(s)
    }
}

enum MarkdownBlock: Equatable {
    case text(String)
    case heading(String)
    case code(String)

    static func parse(_ source: String) -> [MarkdownBlock] {
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

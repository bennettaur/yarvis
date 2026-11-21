import SwiftUI
import YarvisClient

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

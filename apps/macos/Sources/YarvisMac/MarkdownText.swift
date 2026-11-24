import SwiftUI
import YarvisClient

/// Follows a link in model output: opens it in the browser, in the app, or not at all.
struct ChatLinkRouter: Sendable {
    let follow: @MainActor @Sendable (URL) -> Void
}

private struct ChatLinkRouterKey: EnvironmentKey {
    static let defaultValue: ChatLinkRouter? = nil
}

private struct WorkspaceNamesKey: EnvironmentKey {
    static let defaultValue: [String: String] = [:]
}

extension EnvironmentValues {
    /// Without a router a link only opens when it's http(s).
    var chatLinkRouter: ChatLinkRouter? {
        get { self[ChatLinkRouterKey.self] }
        set { self[ChatLinkRouterKey.self] = newValue }
    }

    /// Workspace names by id, so ids in a reply read as links named after them.
    var workspaceNames: [String: String] {
        get { self[WorkspaceNamesKey.self] }
        set { self[WorkspaceNamesKey.self] = newValue }
    }
}

/// Renders model output as markdown: fenced code as monospaced boxes,
/// headings, lists, tables and quotes as blocks, images as their alt text,
/// and everything else through `AttributedString`'s inline markdown, which
/// keeps line breaks.
struct MarkdownText: View {
    let blocks: [MarkdownBlock]
    @Environment(\.chatLinkRouter) private var router
    @Environment(\.workspaceNames) private var workspaceNames

    init(_ source: String) {
        blocks = MarkdownCache.blocks(source)
    }

    init(blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        // Every link goes through the router or `openWebLink`, never the
        // system's handler, which would open any scheme.
        .environment(\.openURL, OpenURLAction { url in
            MainActor.assumeIsolated {
                if let router { router.follow(url) } else { openWebLink(url) }
            }
            return .handled
        })
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
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
        case .list(let start, let items):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(start.map { "\($0 + i)." } ?? (item.depth == 0 ? "•" : "◦"))
                            .monospacedDigit().foregroundStyle(.secondary)
                        Text(inline(item.text)).textSelection(.enabled)
                    }
                    .padding(.leading, CGFloat(item.depth) * 16)
                }
            }
        case .quote(let inner):
            MarkdownText(blocks: inner)
                .foregroundStyle(.secondary)
                .padding(.leading, 10)
                .overlay(alignment: .leading) { Rectangle().fill(.quaternary).frame(width: 3) }
        case .table(let header, let rows):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                    GridRow {
                        ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                            Text(inline(cell)).bold()
                        }
                    }
                    Divider()
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(inline(cell)).textSelection(.enabled)
                            }
                        }
                    }
                }
                .padding(8)
            }
            .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 6))
        case .image(let alt):
            Label(alt.isEmpty ? "Image" : "Image: \(alt)", systemImage: "photo")
                .font(.callout).foregroundStyle(.secondary)
        }
    }

    private func inline(_ s: String) -> AttributedString {
        MarkdownCache.inline(s, names: workspaceNames)
    }
}

/// Parsed markdown by source, so a view redrawn for some other reason (a
/// hover, a new message below) doesn't parse its text again. Cleared when it
/// grows past `limit`: a stream adds an entry per update for the block still
/// being written, and those are never asked for again.
@MainActor
private enum MarkdownCache {
    private struct InlineKey: Hashable {
        var text: String
        var names: [String: String]
    }

    private static let limit = 2000
    private static var parsed: [String: [MarkdownBlock]] = [:]
    private static var inlined: [InlineKey: AttributedString] = [:]

    static func blocks(_ source: String) -> [MarkdownBlock] {
        if let hit = parsed[source] { return hit }
        if parsed.count >= limit { parsed.removeAll() }
        let blocks = MarkdownBlock.parse(source)
        parsed[source] = blocks
        return blocks
    }

    static func inline(_ text: String, names: [String: String]) -> AttributedString {
        let key = InlineKey(text: text, names: names)
        if let hit = inlined[key] { return hit }
        if inlined.count >= limit { inlined.removeAll() }
        let source = linkWorkspaceMentions(MarkdownBlock.replacingImages(in: text), names: names)
        let attributed = (try? AttributedString(markdown: source,
                                                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
        inlined[key] = attributed
        return attributed
    }
}

import SwiftUI
import YarvisClient

/// What hangs in one file's code view: its review threads, comments posted
/// this session, the comment composer, and the reviewer's questions and
/// answers. The same for a diff tab and a file tab, so a thread reads and
/// behaves the same wherever the file is open.
@MainActor
struct ReviewFileAnnotations {
    let context: ReviewTabContext
    let path: String
    /// The head's text, sent with a question so the agent sees what the reader sees.
    let headContent: String
    /// Providers take line comments only on files the PR changes.
    let canComment: Bool

    var store: ReviewAnnotationStore { ReviewAnnotationStore.of(context.pr) }
    private var threads: [PrThread] { context.pr.detail.value?.reviewThreads ?? [] }
    var split: (inline: [PrThread], outdated: [PrThread]) { splitThreads(threads, path: path) }

    /// Every line with something below it, for the code view to place.
    var slots: [CodeAnnotationSlot] {
        let inline = split.inline
        var pending = store.pendingComments(path: path, threads: inline).map(\.target.anchor)
        if let moved = store.movedToFile[path] { pending.append(moved.anchor) }
        let comments = commentAnchors(threads: inline, pending: pending, composer: store.composers[path]?.anchor)
            .map { CodeAnnotationSlot(kind: .comment, side: $0.side, line: $0.line) }
        let asking = store.asking?.path == path ? store.asking?.endLine : nil
        let insights = insightLines(insightsByPath(context.pr.insights.value ?? [])[path] ?? [], asking: asking)
            .map { CodeAnnotationSlot(kind: .insight, side: .right, line: $0) }
        return comments + insights
    }

    func view(for slot: CodeAnnotationSlot) -> AnyView {
        switch slot.kind {
        case .comment:
            AnyView(ReviewLineCommentBlock(context: context, path: path, anchor: ZoneAnchor(side: slot.side, line: slot.line)))
        case .insight:
            AnyView(ReviewInsightBlock(context: context, path: path, line: slot.line))
        }
    }

    func perform(_ action: CodeLineAction) {
        store.setNotice(nil, path: path)
        switch action.kind {
        case .comment:
            guard canComment else {
                store.setNotice("Comments go on files the pull request changes.", path: path)
                return
            }
            store.openComposer(path: path, side: action.side, line: action.startLine, extend: action.extend)
            if action.endLine > action.startLine {
                store.openComposer(path: path, side: action.side, line: action.endLine, extend: true)
            }
        case .ask:
            // An answer is stored against the head's line numbers, so a
            // question about the old file would come back on the wrong lines.
            guard action.side == .right else {
                store.setNotice("Questions are asked about the new version of the file.", path: path)
                return
            }
            store.openAsk(ReviewAsk(path: path, startLine: action.startLine, endLine: action.endLine,
                                    selection: linesText(headContent, start: action.startLine, end: action.endLine)))
        }
    }
}

/// Between a file tab's toolbar and its code: why a line action did nothing,
/// a write that failed, and the threads with no line left to hang under,
/// folded behind a count since they are rarely the first thing to read.
struct ReviewAnnotationBar: View {
    let annotations: ReviewFileAnnotations
    var error: String?
    @State private var showOutdated = false

    var body: some View {
        let outdated = annotations.split.outdated
        let notice = annotations.store.notices[annotations.path]
        // While a question is open its composer shows the error instead.
        let error = error ?? (annotations.store.asking == nil ? annotations.store.insightError : nil)
        if notice != nil || error != nil || !outdated.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                if let notice {
                    HStack(spacing: 6) {
                        Text(notice).foregroundStyle(.secondary)
                        Button {
                            annotations.store.setNotice(nil, path: annotations.path)
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .buttonStyle(.borderless)
                        .help("Dismiss")
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                if !outdated.isEmpty {
                    DisclosureGroup(isExpanded: $showOutdated) {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(Array(outdated.enumerated()), id: \.offset) { _, thread in
                                    PrThreadView(context: annotations.context, thread: thread)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        .frame(maxHeight: 320)
                    } label: {
                        HStack(spacing: 4) {
                            Text(outdatedThreadsLabel(outdated))
                            let open = outdated.filter { !$0.isResolved }.count
                            if open > 0 {
                                Text("(\(open) open)").foregroundStyle(.orange)
                            }
                        }
                        .foregroundStyle(.secondary)
                    }
                }
            }
            .font(.caption)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            Divider()
        }
    }
}

/// Everything below one line on one side: its threads, this session's
/// comments the provider hasn't echoed, a note when GitHub moved the last
/// comment onto the whole file, and the composer when open.
struct ReviewLineCommentBlock: View {
    let context: ReviewTabContext
    let path: String
    let anchor: ZoneAnchor

    private var store: ReviewAnnotationStore { ReviewAnnotationStore.of(context.pr) }

    var body: some View {
        let inline = splitThreads(context.pr.detail.value?.reviewThreads ?? [], path: path).inline
        let threads = threadsByAnchor(inline)[anchor] ?? []
        let pending = store.pendingComments(path: path, threads: inline).filter { $0.target.anchor == anchor }
        let moved = store.movedToFile[path].flatMap { $0.anchor == anchor ? $0 : nil }
        let composer = store.composers[path].flatMap { $0.anchor == anchor ? $0 : nil }
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(threads.enumerated()), id: \.offset) { _, thread in
                PrThreadView(context: context, thread: thread)
            }
            ForEach(pending, id: \.id) { comment in
                VStack(alignment: .leading, spacing: 2) {
                    Text("you · just now").font(.caption.weight(.medium)).foregroundStyle(.tertiary)
                    Text(comment.body).textSelection(.enabled)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            }
            if let moved {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("Posted on the whole file instead. GitHub only takes line comments on lines inside the diff, so the comment names \(describeLines(line: moved.line, side: moved.side, startLine: moved.startLine)) at the top.")
                    Button("Dismiss") { store.dismissMoved(path: path) }.buttonStyle(.link)
                }
                .font(.caption)
                .foregroundStyle(.orange)
            }
            if let composer {
                ReviewCommentComposer(
                    label: needsLineLabel(side: composer.side, startLine: composer.startLine)
                        ? "Commenting on \(describeLines(line: composer.line, side: composer.side, startLine: composer.startLine))"
                        : nil
                ) { body in
                    try await store.submitComment(context, path: path, target: composer, body: body)
                } cancel: {
                    store.closeComposer(path: path)
                }
            }
        }
        .onChange(of: inline, initial: true) { _, next in store.settleComments(path: path, threads: next) }
    }
}

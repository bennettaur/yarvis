import SwiftUI
import YarvisClient

/// A scrolling page for one of the PR's info tabs, with the detail's
/// loading and error states handled once.
private struct DetailPage<Content: View>: View {
    let context: ReviewTabContext
    @ViewBuilder let content: (PrDetail) -> Content

    var body: some View {
        let detail = context.pr.detail
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let value = detail.value {
                    content(value)
                } else if let error = detail.error {
                    Text(error).foregroundStyle(.red).textSelection(.enabled)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .frame(maxWidth: 820, alignment: .leading)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onAppear { context.pr.loadDetail() }
    }
}

struct ReviewDescriptionTab: View {
    let context: ReviewTabContext

    var body: some View {
        DetailPage(context: context) { detail in
            ReviewSectionTitle("Description")
            let body = detail.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if body.isEmpty {
                Text("No description.").foregroundStyle(.secondary)
            } else {
                MarkdownText(body).textSelection(.enabled)
            }
            ReviewSectionTitle("Comments")
            let general = detail.reviewThreads.filter { $0.path == nil || $0.line == nil }
            if general.isEmpty {
                Text("No general comments.").foregroundStyle(.secondary)
            }
            ForEach(Array(general.enumerated()), id: \.offset) { _, thread in
                PrThreadView(context: context, thread: thread, showsLocation: true)
            }
            if detail.reviewThreadsTruncated == true {
                Text("Not every comment thread could be loaded. The rest are on the provider's site.")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
    }
}

struct ReviewReviewersTab: View {
    let context: ReviewTabContext

    var body: some View {
        DetailPage(context: context) { detail in
            ReviewSectionTitle("Reviewers")
            if detail.reviewers.isEmpty {
                Text("No reviewers requested.").foregroundStyle(.secondary)
            }
            ForEach(sortReviewers(detail.reviewers), id: \.login) { reviewer in
                HStack {
                    Circle().fill(Self.color(reviewer.state)).frame(width: 8, height: 8)
                    Text(reviewer.login)
                    Spacer()
                    Chip(text: reviewer.state.label, color: Self.color(reviewer.state))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    static func color(_ state: ReviewerState) -> Color {
        switch state {
        case .approved: return .green
        case .changesRequested: return .red
        case .commented: return .blue
        case .pending: return .orange
        case .dismissed: return .secondary
        }
    }
}

struct ReviewChecksTab: View {
    let context: ReviewTabContext

    var body: some View {
        DetailPage(context: context) { detail in
            HStack {
                ReviewSectionTitle("Checks")
                if !detail.checks.isEmpty {
                    Text("\(detail.checks.count) checks").font(.caption).foregroundStyle(.secondary)
                    CopyButton(text: checksClipboardText(detail.checks), help: "Copy every check")
                }
            }
            if detail.checksUnavailable == true {
                Text("This GitHub token can't read this pull request's checks. A fine-grained token can't be given "
                    + "the Checks permission, so open the PR on GitHub to see them.")
                    .foregroundStyle(.secondary)
            } else if detail.checks.isEmpty {
                Text("No checks reported.").foregroundStyle(.secondary)
            }
            ForEach(Array(detail.checks.enumerated()), id: \.offset) { _, check in
                HStack(spacing: 8) {
                    Text(checkGlyph(check)).foregroundStyle(Self.color(check)).frame(width: 14)
                    if let url = check.url, clipboardSafeURL(url) != nil {
                        Button(check.name) { openExternal(url) }
                            .buttonStyle(.link)
                            .help(url)
                    } else {
                        Text(check.name)
                    }
                    Spacer()
                    Text(checkOutcome(check)).font(.caption).foregroundStyle(.secondary)
                    if let url = clipboardSafeURL(check.url) { CopyButton(text: url, help: "Copy the check's link") }
                }
            }
        }
    }

    static func color(_ check: PrCheck) -> Color {
        switch checkTone(check) {
        case .running: return .orange
        case .passed: return .green
        case .failed: return .red
        }
    }
}

struct ReviewCommentsTab: View {
    let context: ReviewTabContext
    @State private var showResolved = false

    var body: some View {
        DetailPage(context: context) { detail in
            let threads = detail.reviewThreads
            let resolved = threads.filter(\.isResolved).count
            HStack(spacing: 12) {
                ReviewSectionTitle("Comments")
                Text("\(threads.count - resolved) open · \(resolved) resolved")
                    .font(.caption).foregroundStyle(.secondary)
                if resolved > 0 {
                    Button(showResolved ? "Hide resolved" : "Show resolved") { showResolved.toggle() }
                        .controlSize(.small)
                }
            }
            conversation(detail)
            let shown = showResolved ? threads : threads.filter { !$0.isResolved }
            let grouped = groupThreadsByPath(shown)
            if shown.isEmpty {
                Text(threads.isEmpty ? "No review threads." : "Every thread is resolved.").foregroundStyle(.secondary)
            }
            ForEach(Array(grouped.general.enumerated()), id: \.offset) { _, thread in
                PrThreadView(context: context, thread: thread, showsLocation: true)
            }
            ForEach(grouped.files, id: \.path) { group in
                VStack(alignment: .leading, spacing: 8) {
                    Button(group.path) { context.openTab(.diff(prId: context.pr.prId, path: group.path)) }
                        .buttonStyle(.link)
                        .font(.callout.monospaced())
                    ForEach(Array(group.threads.enumerated()), id: \.offset) { _, thread in
                        if let line = thread.line {
                            Button("Go to line \(line) →") {
                                context.openTab(.diff(prId: context.pr.prId, path: group.path, revealLine: line))
                            }
                            .buttonStyle(.link)
                            .font(.caption)
                        }
                        PrThreadView(context: context, thread: thread)
                    }
                }
            }
            if detail.reviewThreadsTruncated == true {
                Text("This PR has more threads than were loaded; open it on the provider to see them all.")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
    }

    @ViewBuilder
    private func conversation(_ detail: PrDetail) -> some View {
        let comments = detail.conversation ?? []
        if !comments.isEmpty {
            ReviewSectionTitle("Conversation")
            if detail.conversationTruncated == true {
                Text("Showing the latest \(comments.count); open the PR on the provider for the rest.")
                    .font(.caption).foregroundStyle(.orange)
            }
            ForEach(comments) { comment in
                VStack(alignment: .leading, spacing: 4) {
                    Text(comment.author).font(.caption.weight(.semibold))
                    MarkdownText(comment.body).textSelection(.enabled)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }
}

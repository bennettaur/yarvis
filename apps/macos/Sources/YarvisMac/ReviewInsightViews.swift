import SwiftUI
import YarvisClient

/// The reviewer's questions about lines and their answers, hung under the
/// last line asked about, and the composer for a new one. Styled apart from
/// review threads: an answer is a private note until the reviewer posts it.
struct ReviewInsightBlock: View {
    let context: ReviewTabContext
    let path: String
    let line: Int

    private var store: ReviewAnnotationStore { ReviewAnnotationStore.of(context.pr) }

    var body: some View {
        let cards = insightsAtLine(insightsByPath(context.pr.insights.value ?? [])[path] ?? [], line: line)
        let composing = store.asking.map { $0.path == path && $0.endLine == line } ?? false
        VStack(alignment: .leading, spacing: 8) {
            ForEach(cards) { insight in
                ReviewInsightCard(context: context, insight: insight)
            }
            if composing {
                ReviewAskComposer(context: context)
            }
        }
    }
}

private struct ReviewInsightCard: View {
    let context: ReviewTabContext
    let insight: PrInsight

    private var store: ReviewAnnotationStore { ReviewAnnotationStore.of(context.pr) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("Insight").font(.caption.weight(.semibold)).foregroundStyle(.purple)
                if insightIsStale(insight, currentSha: context.pr.pr.headSha ?? "") {
                    Text("Out of date")
                        .font(.caption2)
                        .padding(.horizontal, 5)
                        .background(Color.orange.opacity(0.2), in: Capsule())
                        .help("Answered against \(String(insight.headSha.prefix(7))); the pull request has moved since.")
                }
                Spacer(minLength: 0)
                if insight.postedAt != nil {
                    Text("Posted to the PR").font(.caption).foregroundStyle(.green)
                } else {
                    Button("Post") { Task { await store.postInsight(context, id: insight.id) } }
                        .help("Post this as a comment on the pull request")
                        .controlSize(.small)
                }
                Button {
                    Task { await store.deleteInsight(context, id: insight.id) }
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(.borderless)
                .help("Delete this insight")
            }
            if insight.placement == .file {
                Text("Posted on the whole file instead: GitHub only takes line comments on lines inside the diff.")
                    .font(.caption).foregroundStyle(.orange)
            }
            Text(insight.question).font(.caption).italic().foregroundStyle(.secondary).textSelection(.enabled)
            // No link router here, so only http(s) links in the answer open.
            MarkdownText(insight.answer).textSelection(.enabled)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.purple.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.purple.opacity(0.35)))
    }
}

/// A question about the lines it hangs under. Enter sends, since questions
/// are one-liners; Shift-Enter starts a new line.
private struct ReviewAskComposer: View {
    let context: ReviewTabContext
    @State private var question = ""
    @FocusState private var focused: Bool

    private var store: ReviewAnnotationStore { ReviewAnnotationStore.of(context.pr) }

    var body: some View {
        let pending = store.askPending
        VStack(alignment: .leading, spacing: 6) {
            TextEditor(text: $question)
                .font(.callout)
                .frame(height: 60)
                .focused($focused)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                .overlay(alignment: .topLeading) {
                    if question.isEmpty {
                        Text("Ask about these lines — what calls this, why is it here, what would break…")
                            .foregroundStyle(.tertiary).padding(.horizontal, 9).padding(.vertical, 4)
                            .allowsHitTesting(false)
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.purple.opacity(0.4)))
                .disabled(pending)
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    send()
                    return .handled
                }
            if let error = store.insightError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            HStack(spacing: 8) {
                Button(pending ? "Looking…" : "Ask", action: send)
                    .buttonStyle(.borderedProminent)
                    .disabled(pending || question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Cancel") { store.closeAsk() }.disabled(pending)
                if pending {
                    Text("Reading the code around this…").font(.caption).foregroundStyle(.secondary)
                }
            }
            .controlSize(.small)
        }
        .padding(8)
        .background(Color.purple.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
        .onAppear { focused = true }
    }

    private func send() {
        let text = question
        Task { await store.submitAsk(context, question: text) }
    }
}

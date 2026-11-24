import SwiftUI
import YarvisClient

/// One provider review thread with its reply and resolve actions. Used by
/// the Comments tab, inline in diffs, and by the re-review summary. A reply
/// or resolve shows at once and stays shown until the refetched thread
/// agrees, rather than blinking away on a read that hasn't caught up.
struct PrThreadView: View {
    let context: ReviewTabContext
    let thread: PrThread
    var showsLocation = false

    @State private var replying = false
    @State private var toggling = false
    @State private var toggleError: String?

    private var store: ReviewAnnotationStore { ReviewAnnotationStore.of(context.pr) }

    var body: some View {
        let (shown, pending) = store.shown(thread)
        let mayToggle = shown.isResolved ? shown.canUnresolve : shown.canResolve
        VStack(alignment: .leading, spacing: 8) {
            header(shown)
            ForEach(Array(shown.comments.enumerated()), id: \.offset) { _, comment in
                VStack(alignment: .leading, spacing: 2) {
                    Text(comment.author).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    MarkdownText(comment.body).textSelection(.enabled)
                }
            }
            ForEach(pending, id: \.id) { reply in
                VStack(alignment: .leading, spacing: 2) {
                    Text("you · just now").font(.caption.weight(.medium)).foregroundStyle(.tertiary)
                    Text(reply.body).textSelection(.enabled)
                }
            }
            if let toggleError {
                Text(toggleError).font(.caption).foregroundStyle(.red)
            }
            if replying {
                ReviewCommentComposer(placeholder: "Reply…", submitLabel: "Reply") { body in
                    try await store.reply(context, to: thread, body: body)
                    replying = false
                } cancel: {
                    replying = false
                }
            } else if shown.canReply || mayToggle {
                HStack(spacing: 8) {
                    if shown.canReply {
                        Button("Reply") { replying = true }
                    }
                    if mayToggle {
                        Button(shown.isResolved ? "Unresolve" : "Resolve") { toggle(to: !shown.isResolved) }
                            .disabled(toggling)
                    }
                }
                .controlSize(.small)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.secondary.opacity(0.2)))
        .onChange(of: thread, initial: true) { _, next in store.settle([next]) }
    }

    @ViewBuilder
    private func header(_ shown: PrThread) -> some View {
        HStack(spacing: 8) {
            if showsLocation {
                Text("\(shown.path ?? "(general)")\(shown.line.map { ":\($0)" } ?? "")")
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            if let line = shown.line, needsLineLabel(side: shown.side, startLine: shown.startLine) {
                Text(describeLines(line: line, side: shown.side, startLine: shown.startLine, startSide: shown.startSide))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(shown.isResolved ? "resolved" : "open")
                .font(.caption).foregroundStyle(shown.isResolved ? .green : .orange)
            if shown.isOutdated {
                Text("outdated").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if let link = shown.comments.first?.url, let provider = threadProviderName(link),
               let url = URL(string: link) {
                Button("open on \(provider) ↗") { openWebLink(url) }
                    .buttonStyle(.link).font(.caption)
            }
        }
    }

    private func toggle(to resolved: Bool) {
        toggling = true
        toggleError = nil
        Task {
            do {
                try await store.setResolved(context, thread, resolved)
            } catch {
                toggleError = error.localizedDescription
            }
            toggling = false
        }
    }
}

/// A text box with submit and cancel, for a new comment or a reply. A failed
/// submit keeps the text and shows why, so a post never loses what was written.
struct ReviewCommentComposer: View {
    var label: String?
    var placeholder = "Leave a comment…"
    var submitLabel = "Comment"
    let submit: (String) async throws -> Void
    let cancel: () -> Void

    @State private var text = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let label {
                Text(label).font(.caption).foregroundStyle(.secondary)
            }
            TextEditor(text: $text)
                .font(.callout)
                .frame(height: 80)
                .focused($focused)
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(placeholder).foregroundStyle(.tertiary).padding(.horizontal, 9).padding(.vertical, 4)
                            .allowsHitTesting(false)
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.secondary.opacity(0.3)))
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            HStack(spacing: 8) {
                Button(busy ? "Posting…" : submitLabel, action: run)
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || trimmed.isEmpty)
                Button("Cancel", action: cancel).disabled(busy)
            }
            .controlSize(.small)
        }
        .padding(8)
        .background(Color.accentColor.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
        .onAppear { focused = true }
    }

    private func run() {
        guard !trimmed.isEmpty else { return }
        busy = true
        error = nil
        let body = trimmed
        Task {
            do {
                try await submit(body)
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

import SwiftUI
import YarvisClient

/// One thing heads-down mode is waiting on the user for. A question offers the
/// options the pass gave plus a free-text answer; an approval shows the exact
/// call it would make, since approving lets that call, and only that one, run.
struct HeadsDownQuestionCard: View {
    let model: HeadsDownModel
    let question: HeadsDownQuestion
    let onAnswered: () -> Void
    @State private var answerText = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(question.isApproval ? "APPROVAL" : "QUESTION")
                .font(.caption.weight(.medium)).foregroundStyle(.orange)
            HeadsDownMentionText(text: question.question).textSelection(.enabled)
            if let situation = question.situation, !question.isApproval {
                HeadsDownMentionText(text: situation).font(.caption).foregroundStyle(.secondary)
            }
            if question.isApproval, let args = question.toolArgs {
                ScrollView {
                    Text(args.prettyPrinted).font(.caption.monospaced()).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 180)
                .padding(8)
                .background(.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 6))
            }
            buttons
            if !question.isApproval {
                HStack {
                    TextField("Or answer in your own words", text: $answerText)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(answerInWords)
                        .accessibilityLabel("Answer")
                    Button("Answer", action: answerInWords)
                        .buttonStyle(.borderedProminent)
                        .disabled(busy || trimmed.isEmpty)
                }
            }
            HStack {
                Button("Dismiss") { run { try await $0.dismissHeadsDownQuestion(id: question.id) } }
                    .buttonStyle(.link)
                    .font(.caption)
                    .disabled(busy)
                Spacer()
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
        }
        .headsDownCard(tint: .orange)
    }

    @ViewBuilder private var buttons: some View {
        let id = question.id
        HStack {
            if question.isApproval {
                Button("Approve this call") { run { try await $0.answerHeadsDownQuestion(id: id, choice: "approve") } }
                    .buttonStyle(.borderedProminent)
                Button("Deny") { run { try await $0.answerHeadsDownQuestion(id: id, choice: "deny") } }
                if let tool = question.mcpTool {
                    Button("Always allow \(question.mcpToolName ?? tool) in heads-down mode") {
                        run {
                            try await $0.setHeadsDownToolAllowed(tool, allowed: true)
                            try await $0.answerHeadsDownQuestion(id: id, choice: "approve")
                        }
                    }
                    .help("Lets heads-down mode call \(tool) without asking, and approves this call")
                }
            } else {
                ForEach(question.options, id: \.self) { option in
                    Button(option) { run { try await $0.answerHeadsDownQuestion(id: id, choice: option) } }
                }
            }
        }
        .disabled(busy)
    }

    private var trimmed: String { answerText.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func answerInWords() {
        let text = trimmed
        guard !busy, !text.isEmpty else { return }
        let id = question.id
        run { try await $0.answerHeadsDownQuestion(id: id, answer: text) }
    }

    /// Calls the client itself rather than `perform`, since what to read
    /// again is the caller's: the page reads its lists, the dialog its next question.
    private func run(_ action: @escaping @Sendable (YarvisClient) async throws -> Void) {
        busy = true
        error = nil
        let client = model.client
        Task {
            defer { busy = false }
            do {
                try await action(client)
                onAnswered()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

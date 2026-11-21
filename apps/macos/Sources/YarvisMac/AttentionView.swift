import SwiftUI
import YarvisClient

struct AttentionView: View {
    @Bindable var model: AttentionModel

    var body: some View {
        List {
            if !model.approvals.isEmpty {
                SwiftUI.Section("Approvals") {
                    ForEach(model.approvals) { a in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(a.summary)
                                Text(a.kind).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Deny") { model.answer(a, approve: false) }
                            Button("Approve") { model.answer(a, approve: true) }.buttonStyle(.borderedProminent)
                        }
                    }
                }
            }
            SwiftUI.Section("Needs you") {
                if model.items.isEmpty {
                    Text("Nothing waiting.").foregroundStyle(.secondary)
                }
                ForEach(model.items) { item in
                    HStack(alignment: .top) {
                        Image(systemName: symbol(item.kind)).frame(width: 18)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title).bold()
                            if let body = item.body { Text(body).lineLimit(3).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Button(actionLabel(item)) { model.open(item) }
                        Button { model.dismiss(item) } label: { Image(systemName: "xmark") }
                            .buttonStyle(.borderless)
                            .help("Dismiss")
                    }
                    .padding(.vertical, 2)
                }
            }
            if let error = model.error {
                Text(error).foregroundStyle(.red).textSelection(.enabled)
            }
        }
        .sheet(item: $model.answering) { item in
            AnswerSheet(model: model, item: item)
        }
    }

    private func actionLabel(_ item: AttentionItem) -> String {
        if item.kind == "question" { return "Answer" }
        if item.isHookPermission { return "Review" }
        return "Open"
    }

    private func symbol(_ kind: String) -> String {
        switch kind {
        case "permission": return "lock"
        case "question": return "questionmark.bubble"
        case "error": return "exclamationmark.triangle"
        case "completed": return "checkmark.circle"
        case "idle": return "hourglass"
        default: return "bell"
        }
    }
}

/// Answers a question or a permission prompt behind an attention item.
struct AnswerSheet: View {
    let model: AttentionModel
    let item: AttentionItem
    @Environment(AppModel.self) private var app
    @State private var questions: [AgentQuestion] = []
    @State private var permission: PermissionRequest?
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(item.title).font(.headline)
            if !loaded {
                ProgressView()
            } else if let permission {
                PermissionForm(request: permission) { decision in
                    submit { [client = app.client!] in
                        if try await !client.answerPermission(id: permission.id, decision) {
                            throw Gone()
                        }
                    }
                }
            } else if let q = questions.first {
                QuestionForm(question: q) { answers in
                    submit { [client = app.client!] in try await client.answerQuestion(id: q.id, answers) }
                } decline: {
                    submit { [client = app.client!] in try await client.declineQuestion(id: q.id) }
                }
            } else {
                Text("This isn't waiting for an answer any more.").foregroundStyle(.secondary)
            }
            if let error { Text(error).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("Close") { model.answering = nil }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(20)
        .frame(width: 520)
        .task { await load() }
    }

    struct Gone: LocalizedError {
        var errorDescription: String? { "It stopped waiting: answered in the terminal, or timed out." }
    }

    private func load() async {
        guard let client = app.client else { return }
        do {
            if item.isHookPermission {
                let requestId = item.payload?["requestId"]?.stringValue
                let all = try await client.permissionRequests(sessionKey: item.sessionKey)
                permission = all.first { $0.id == requestId } ?? all.first
            } else {
                questions = try await client.questions(for: item)
            }
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func submit(_ action: @escaping @Sendable () async throws -> Void) {
        Task {
            do {
                try await app.fresh(action)
                model.finished(item)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

struct PermissionForm: View {
    let request: PermissionRequest
    let answer: (PermissionDecision) -> Void
    @State private var denyMessage = ""
    @State private var drafts: [Int: QuestionDraft] = [:]

    /// Claude Code's AskUserQuestion arrives as a permission prompt whose
    /// input holds the questions.
    private var askedQuestions: [QuestionItem]? {
        guard request.toolName == "AskUserQuestion", let raw = request.toolInput["questions"],
              let data = try? JSONEncoder().encode(raw) else { return nil }
        return try? JSONDecoder().decode([QuestionItem].self, from: data)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let ws = request.workspaceName { Text(ws).foregroundStyle(.secondary) }
            if let questions = askedQuestions {
                ForEach(Array(questions.enumerated()), id: \.offset) { i, q in
                    QuestionFields(item: q, draft: Binding(get: { drafts[i] ?? QuestionDraft() }, set: { drafts[i] = $0 }))
                }
                HStack {
                    Button("Answer in the terminal") { answer(.terminal) }
                    Spacer()
                    Button("Send answers") {
                        var answers: [String: String] = [:]
                        for (i, q) in questions.enumerated() {
                            let d = drafts[i] ?? QuestionDraft()
                            // The web's encoding: picks joined with ", ", then any typed text.
                            let parts = [d.selected.sorted().joined(separator: ", "),
                                         d.text.trimmingCharacters(in: .whitespacesAndNewlines)].filter { !$0.isEmpty }
                            answers[q.question] = parts.joined(separator: "\n")
                        }
                        answer(.answer(answers))
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else {
                Text("\(request.toolName) wants to run:").bold()
                ScrollView {
                    Text(request.toolInput.prettyPrinted).font(.caption.monospaced()).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 220)
                if let cwd = request.cwd { Text("in \(cwd)").font(.caption).foregroundStyle(.secondary) }
                TextField("Reason for denying (optional)", text: $denyMessage)
                HStack {
                    Button("Answer in the terminal") { answer(.terminal) }
                    Spacer()
                    Button("Deny") { answer(.deny(message: denyMessage)) }
                    Button("Allow") { answer(.allow) }.buttonStyle(.borderedProminent)
                }
            }
        }
    }
}

struct QuestionDraft {
    var selected: Set<String> = []
    var text = ""
}

struct QuestionFields: View {
    let item: QuestionItem
    @Binding var draft: QuestionDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let header = item.header { Text(header).font(.caption).foregroundStyle(.secondary) }
            Text(item.question).bold()
            ForEach(item.options ?? [], id: \.label) { option in
                Toggle(isOn: Binding(
                    get: { draft.selected.contains(option.label) },
                    set: { on in
                        if item.multiSelect == true {
                            if on { draft.selected.insert(option.label) } else { draft.selected.remove(option.label) }
                        } else {
                            draft.selected = on ? [option.label] : []
                        }
                    })) {
                    VStack(alignment: .leading) {
                        Text(option.label)
                        if let d = option.description { Text(d).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                .toggleStyle(.checkbox)
            }
            TextField("Or type an answer", text: $draft.text)
        }
    }
}

struct QuestionForm: View {
    let question: AgentQuestion
    let answer: ([QuestionAnswer]) -> Void
    let decline: () -> Void
    @State private var drafts: [Int: QuestionDraft] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(question.context.task).foregroundStyle(.secondary)
            if let reason = question.context.reason { Text(reason).font(.callout).foregroundStyle(.secondary) }
            ForEach(Array(question.questions.enumerated()), id: \.offset) { i, q in
                QuestionFields(item: q, draft: Binding(get: { drafts[i] ?? QuestionDraft() }, set: { drafts[i] = $0 }))
            }
            HStack {
                Button("Decline") { decline() }
                Spacer()
                Button("Send answers") {
                    answer(question.questions.indices.map { i in
                        let d = drafts[i] ?? QuestionDraft()
                        let text = d.text.trimmingCharacters(in: .whitespacesAndNewlines)
                        return QuestionAnswer(selected: Array(d.selected).sorted(), text: text.isEmpty ? nil : text)
                    })
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }
}

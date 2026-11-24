import SwiftUI
import YarvisClient

struct ChatView: View {
    @Bindable var chat: ChatModel

    var body: some View {
        HSplitView {
            threadList.frame(minWidth: 200, idealWidth: 240, maxWidth: 320)
            thread.frame(minWidth: 420)
        }
    }

    private var threadList: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Threads").font(.headline)
                Spacer()
                Button { chat.newThread() } label: { Image(systemName: "square.and.pencil") }
                    .help("New thread")
            }
            .padding(10)
            List(chat.sessions, selection: Binding(get: { chat.selectedId }, set: { chat.open($0) })) { s in
                VStack(alignment: .leading) {
                    Text(s.title ?? "Untitled").lineLimit(1)
                    Text(relative(s.updatedAt)).font(.caption2).foregroundStyle(.secondary)
                }
                .tag(s.id)
            }
        }
    }

    private var thread: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(chat.messages) { MessageRow(message: $0) }
                        if chat.isStreaming || !chat.liveTools.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                ToolActivityList(tools: chat.liveTools)
                                if !chat.reply.isEmpty {
                                    MarkdownText(chat.reply)
                                } else if chat.isStreaming {
                                    ProgressView().controlSize(.small)
                                }
                            }
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(16)
                }
                .onChange(of: chat.reply) { proxy.scrollTo("end", anchor: .bottom) }
                .onChange(of: chat.messages.count) { proxy.scrollTo("end", anchor: .bottom) }
            }
            if let notice = chat.notice {
                Text(notice).font(.callout).foregroundStyle(.secondary).padding(.horizontal, 16).padding(.bottom, 4)
            }
            if let error = chat.error {
                Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled)
                    .padding(.horizontal, 16).padding(.bottom, 4)
            }
            if let front = chat.approvals.first {
                ToolApprovalBar(request: front, waitingCount: chat.approvals.count - 1) { approved in
                    chat.answer(front, approved: approved)
                }
            }
            composer
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            HStack(alignment: .bottom) {
                TextField("Message Yarvis", text: $chat.draft, axis: .vertical)
                    .lineLimit(1...8)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { chat.send() }
                if chat.isStreaming {
                    Button("Stop", role: .destructive) { chat.stop() }
                        .keyboardShortcut(".", modifiers: .command)
                } else {
                    Button("Send") { chat.send() }
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            ModelPicker(chat: chat)
        }
        .padding(12)
    }
}

private func relative(_ iso: String) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return "" }
    return date.formatted(.relative(presentation: .named))
}

struct ModelPicker: View {
    @Bindable var chat: ChatModel

    var body: some View {
        HStack {
            Menu {
                ForEach(chat.providers) { p in
                    Menu(p.label) {
                        ForEach(p.models, id: \.id) { m in
                            Button(m.id) { chat.choose(provider: p.id, model: m.id) }
                        }
                    }
                    .disabled(!p.available)
                }
            } label: {
                Text(chat.model ?? "No model").font(.caption)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            Spacer()
        }
    }
}

struct MessageRow: View {
    let message: ChatMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(message.role == "user" ? "You" : "Yarvis").font(.caption.bold()).foregroundStyle(.secondary)
            if let tools = message.toolCalls, !tools.isEmpty {
                ToolActivityList(tools: tools)
            }
            if message.role == "user" {
                Text(message.content).textSelection(.enabled)
            } else {
                MarkdownText(message.content)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One compact line per tool call: name, status, and the result on hover.
struct ToolActivityList: View {
    let tools: [ToolActivity]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(tools) { t in
                HStack(spacing: 6) {
                    statusIcon(t.status)
                    Text(t.server.map { "\($0) · \(t.name)" } ?? t.name).font(.caption.monospaced())
                    if let ms = t.durationMs { Text("\(Int(ms)) ms").font(.caption2).foregroundStyle(.secondary) }
                }
                .help(t.result ?? "")
            }
        }
    }

    @ViewBuilder private func statusIcon(_ status: String) -> some View {
        switch status {
        case "ok": Image(systemName: "checkmark.circle").foregroundStyle(.green)
        case "error": Image(systemName: "xmark.circle").foregroundStyle(.red)
        case "denied": Image(systemName: "hand.raised").foregroundStyle(.orange)
        default: ProgressView().controlSize(.mini)
        }
    }
}

/// The front of the approval queue, like the web's `ToolApprovalBar`.
struct ToolApprovalBar: View {
    let request: ToolApprovalRequest
    let waitingCount: Int
    let answer: (Bool) -> Void
    @State private var showArgs = false

    private var hasReason: Bool { !(request.reason ?? "").isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Approve?").bold()
                Text(request.name).font(.body.monospaced())
                if let server = request.server, !server.isEmpty { Text("on \(server)").foregroundStyle(.secondary) }
                if waitingCount > 0 { Text("+\(waitingCount) waiting").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Group {
                    Button("Deny") { answer(false) }
                    Button("Approve") { answer(true) }.buttonStyle(.borderedProminent)
                }
                .armedAfterAppearing(id: request.id)
            }
            // A URL is shown in full, since where a call goes is what matters most.
            if let url = request.args?["url"]?.stringValue {
                Text(url).font(.caption.monospaced()).textSelection(.enabled)
            }
            if hasReason, let reason = request.reason {
                Text("The assistant says: \(reason)").font(.callout).foregroundStyle(.secondary)
            }
            // A stated reason is the model's claim, so the arguments it
            // describes stay in view to check it against.
            DisclosureGroup("Arguments", isExpanded: Binding(get: { showArgs || hasReason },
                                                             set: { showArgs = $0 })) {
                ScrollView {
                    Text(request.args?.prettyPrinted ?? "{}").font(.caption.monospaced()).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 160)
            }
        }
        .padding(12)
        .background(.yellow.opacity(0.12))
        .id(request.id)
    }
}

extension View {
    /// Disables approve and deny buttons for a moment after a new request
    /// takes their place, as the web's bar arms its keys, so a double click
    /// can't answer one the user never saw.
    func armedAfterAppearing(id: String) -> some View {
        modifier(ArmedAfterAppearing(id: id))
    }
}

private struct ArmedAfterAppearing: ViewModifier {
    let id: String
    @State private var armed = false

    func body(content: Content) -> some View {
        content
            .disabled(!armed)
            .task(id: id) {
                armed = false
                try? await Task.sleep(for: .milliseconds(400))
                armed = true
            }
    }
}

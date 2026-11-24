import AppKit
import SwiftUI
import YarvisClient

/// A user or assistant message. A saved user message can be resent or
/// edited and resent, which drops every reply after it.
struct MessageRow: View {
    let message: ChatMessage
    let thread: ChatThread
    @State private var hovering = false
    @State private var editing: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(chatMessageLabel(role: message.role == "user" ? "You" : "Yarvis", metadata: message.metadata))
                    .font(.caption.bold()).foregroundStyle(.secondary)
                if canRewind, hovering, editing == nil {
                    Button("Resend") { thread.rewind(to: message.id, text: message.content) }
                    Button("Edit") { editing = message.content }
                }
            }
            .buttonStyle(.borderless).font(.caption)
            if message.role == "assistant" {
                let tools = message.toolCalls ?? []
                let reasoning = thread.reasoning[message.id]
                if !tools.isEmpty || reasoning != nil {
                    TurnActivity(tools: tools, reasoning: reasoning?.text ?? "", reasoningLive: false,
                                 reasoningSeconds: reasoning?.seconds, folded: true)
                }
                MarkdownText(message.content)
            } else if let text = editing {
                editor(text)
            } else {
                Text(message.content).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onHover { hovering = $0 }
    }

    private var canRewind: Bool { message.role == "user" && isSavedMessage(message) && !thread.busy }

    private func editor(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            TextEditor(text: Binding(get: { editing ?? text }, set: { editing = $0 }))
                .font(.body).frame(minHeight: 60, maxHeight: 200)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            HStack {
                Text("Replies after this message are discarded.").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { editing = nil }
                Button("Save & resend") {
                    let edited = editing ?? text
                    editing = nil
                    thread.rewind(to: message.id, text: edited)
                }
                .buttonStyle(.borderedProminent)
                .disabled((editing ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || thread.busy)
            }
        }
    }
}

/// A turn's reasoning and tool calls. A finished turn folds them under one
/// summary line; the live one stays open until its reply starts.
struct TurnActivity: View {
    let tools: [ToolActivity]
    let reasoning: String
    let reasoningLive: Bool
    let reasoningSeconds: Int?
    let folded: Bool
    /// The user's own choice, which wins over `folded` once made.
    @State private var expanded: Bool?

    var body: some View {
        let open = expanded ?? !folded
        VStack(alignment: .leading, spacing: 6) {
            if folded || expanded != nil {
                Button {
                    expanded = !open
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: open ? "chevron.down" : "chevron.right").font(.caption2)
                        Text(toolActivitySummary(tools, thought: !reasoning.isEmpty)).font(.caption)
                    }
                    .foregroundStyle(.secondary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if open {
                if !reasoning.isEmpty {
                    ReasoningView(text: reasoning, streaming: reasoningLive, seconds: reasoningSeconds)
                }
                ForEach(tools) { ToolCard(tool: $0) }
            }
        }
    }
}

/// The model's reasoning: open while it streams, folded a second after it
/// stops, then labelled with how long it took.
struct ReasoningView: View {
    let text: String
    let streaming: Bool
    let seconds: Int?
    @State private var open: Bool

    init(text: String, streaming: Bool, seconds: Int?) {
        self.text = text
        self.streaming = streaming
        self.seconds = seconds
        _open = State(initialValue: streaming)
    }

    private var title: String {
        if streaming { return "Thinking…" }
        return seconds.map { "Thought for \($0) second\($0 == 1 ? "" : "s")" } ?? "Thought about it"
    }

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            ScrollView {
                Text(text).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 256)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "brain").foregroundStyle(.secondary)
                Text(title).font(.caption)
                if streaming { ProgressView().controlSize(.mini) }
            }
        }
        .task(id: streaming) {
            if streaming {
                open = true
            } else {
                try? await Task.sleep(for: .seconds(1))
                if !Task.isCancelled { open = false }
            }
        }
    }
}

/// One tool call: name, server, status, duration, and its arguments and
/// result on demand.
struct ToolCard: View {
    let tool: ToolActivity
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { open.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: "wrench.and.screwdriver").foregroundStyle(.secondary)
                    Text(tool.name).font(.caption.monospaced())
                    if let server = tool.server, !server.isEmpty {
                        Text("on \(server)").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let ms = tool.durationMs {
                        Text(formatToolDuration(ms)).font(.caption2).foregroundStyle(.secondary)
                    }
                    badge
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(.caption2).foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                Text("Arguments").font(.caption2.bold()).foregroundStyle(.secondary)
                ScrollView {
                    Text(tool.args?.prettyPrinted ?? "{}").font(.caption.monospaced()).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 160)
                if let result = tool.result, !result.isEmpty {
                    Text(tool.status == "error" ? "Error" : "Result").font(.caption2.bold()).foregroundStyle(.secondary)
                    ScrollView {
                        Text(result).font(.caption.monospaced()).textSelection(.enabled)
                            .foregroundStyle(tool.status == "error" ? .red : .primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 160)
                }
            }
        }
        .padding(8)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder private var badge: some View {
        switch tool.status {
        case "ok": statusLabel("Completed", .green)
        case "error": statusLabel("Error", .red)
        case "denied": statusLabel("Denied", .orange)
        default:
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini)
                Text("Running").font(.caption2)
            }
        }
    }

    private func statusLabel(_ text: String, _ color: Color) -> some View {
        Text(text).font(.caption2.bold()).foregroundStyle(color)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(color.opacity(0.15), in: Capsule())
    }
}

/// How long a new approval request ignores clicks and keys.
private let approvalArmingDelay: Duration = .milliseconds(400)

/// The front of the approval queue. A and D answer it from the keyboard while no text field has focus; the bar is
/// only on screen for the visible tab, so the keys can't answer a hidden one.
struct ToolApprovalBar: View {
    let request: ToolApprovalRequest
    let waitingCount: Int
    let answer: (Bool) -> Void
    let alwaysAllow: () -> Void
    @State private var showArgs = false
    @State private var keys = ApprovalKeys()

    private var hasReason: Bool { !(request.reason ?? "").isEmpty }
    private var isMcp: Bool { request.toolId?.hasPrefix("mcp:") ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Approve?").bold()
                Text(request.name).font(.body.monospaced())
                if let server = request.server, !server.isEmpty { Text("on \(server)").foregroundStyle(.secondary) }
                if waitingCount > 0 { Text("+\(waitingCount) waiting").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Group {
                    Button("Deny") { answer(false) }.help("Deny (D)")
                    if isMcp {
                        Button("Always allow") { alwaysAllow() }
                            .help("Approve this call and stop asking about \(request.toolId ?? request.name)")
                    }
                    Button("Approve") { answer(true) }.buttonStyle(.borderedProminent).help("Approve (A)")
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
        .background(WindowReader { keys.window = $0 })
        .onAppear { keys.install() }
        .onDisappear { keys.remove() }
        .task(id: request.id) {
            keys.onKey = answer
            keys.armed = false
            try? await Task.sleep(for: approvalArmingDelay)
            keys.armed = !Task.isCancelled
        }
    }
}

/// The A / D key monitor behind `ToolApprovalBar`.
@MainActor
private final class ApprovalKeys {
    var onKey: ((Bool) -> Void)?
    var armed = false
    /// The bar's window. Keys typed in any other, such as the web UI's, are left alone.
    weak var window: NSWindow?
    private var monitor: Any?

    func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            MainActor.assumeIsolated { self?.handle(event) ?? false } ? nil : event
        }
    }

    func remove() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    /// True when the key answered the request.
    private func handle(_ event: NSEvent) -> Bool {
        guard armed, !event.isARepeat, let window, event.window === window,
              event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
              !(event.window?.firstResponder is NSText) else { return false }
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "a": onKey?(true)
        case "d": onKey?(false)
        default: return false
        }
        return true
    }
}

/// Hands its view's window to `found` once it's in one.
private struct WindowReader: NSViewRepresentable {
    let found: (NSWindow?) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { [weak view] in found(view?.window) }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async { [weak view] in found(view?.window) }
    }
}

extension View {
    /// Disables approve and deny buttons for a moment after a new request
    /// takes their place, so a double click or a key press meant for the
    /// last one can't answer one the user never saw.
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
                try? await Task.sleep(for: approvalArmingDelay)
                armed = true
            }
    }
}

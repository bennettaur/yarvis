import AppKit
import SwiftUI
import YarvisClient

/// The Chat page: the "Chats" history, a strip of tabs, the front tab's
/// thread and an optional artifact pane, laid out as the web's `ChatTabs`.
struct ChatView: View {
    @Bindable var chat: ChatModel

    var body: some View {
        HStack(spacing: 0) {
            if chat.historyOpen {
                ChatHistory(chat: chat).frame(width: 256)
                Divider()
            }
            HSplitView {
                VStack(spacing: 0) {
                    ChatTabStrip(chat: chat)
                    Divider()
                    if let thread = chat.activeThread {
                        ChatPanel(thread: thread, chat: chat).id(thread.id)
                    } else {
                        Spacer()
                    }
                }
                .frame(minWidth: 420)
                if let pane = chat.artifact {
                    ChatArtifactPane(pane: pane, chat: chat)
                }
            }
        }
        .environment(\.chatLinkRouter, ChatLinkRouter { chat.follow($0) })
        .environment(\.workspaceNames, chat.workspaceNames)
        .onAppear {
            chat.becameVisible()
            chat.mcp.startPolling()
        }
        .onDisappear { chat.mcp.stopPolling() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            chat.becameVisible()
        }
    }
}

/// Every chat, newest first. Ones open in a tab read brighter, and the
/// front tab's is highlighted.
private struct ChatHistory: View {
    @Bindable var chat: ChatModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Chats").font(.headline)
                Spacer()
                Button { chat.historyOpen = false } label: { Image(systemName: "sidebar.left") }
                    .buttonStyle(.borderless).help("Hide chats")
            }
            .padding(10)
            if let error = chat.sessionsError {
                Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled).padding(.horizontal, 10)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(chat.sessions) { row($0) }
                }
                .padding(.horizontal, 6)
            }
        }
    }

    private func row(_ s: ChatSession) -> some View {
        let title = s.title ?? "Untitled chat"
        let active = chat.activeThread?.sessionId == s.id
        let open = chat.isOpen(sessionId: s.id)
        return Button { chat.openSession(s.id) } label: {
            Text(title).lineLimit(1).truncationMode(.tail)
                .foregroundStyle(active || open ? .primary : .secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(active ? Color.accentColor.opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(title)
    }
}

private struct ChatTabStrip: View {
    @Bindable var chat: ChatModel

    var body: some View {
        HStack(spacing: 4) {
            if !chat.historyOpen {
                Button { chat.historyOpen = true } label: { Image(systemName: "sidebar.left") }
                    .buttonStyle(.borderless).help("Show chats")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(chat.tabs.tabs) { tab($0) }
                }
            }
            Button { chat.newTab() } label: { Image(systemName: "plus") }
                .buttonStyle(.borderless).help("New chat")
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
    }

    private func tab(_ tab: ChatTabsState.Tab) -> some View {
        let label = chat.label(tab)
        let thread = chat.thread(tab.id)
        let active = chat.tabs.activeId == tab.id
        return HStack(spacing: 5) {
            if thread?.awaitingApproval == true {
                Circle().fill(.orange).frame(width: 7, height: 7).help("\(label) — needs your approval")
            } else if thread?.busy == true {
                BusyDot()
            }
            Text(label).lineLimit(1).frame(maxWidth: 160, alignment: .leading)
            Button { chat.close(tab.id) } label: { Image(systemName: "xmark").font(.caption2) }
                .buttonStyle(.borderless).help("Close tab")
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(active ? Color.accentColor.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { chat.select(tab.id) }
        .help(label)
    }
}

private struct BusyDot: View {
    @State private var dim = false

    var body: some View {
        Circle().fill(.green).frame(width: 7, height: 7).opacity(dim ? 0.3 : 1)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.8).repeatForever()) { dim = true }
            }
    }
}

/// One tab's thread: the conversation, then the approval bar, errors, MCP
/// issues, the queue and the composer.
private struct ChatPanel: View {
    @Bindable var thread: ChatThread
    let chat: ChatModel

    var body: some View {
        VStack(spacing: 0) {
            ChatConversation(thread: thread)
            if let front = thread.approvals.first {
                ToolApprovalBar(request: front, waitingCount: thread.approvals.count - 1,
                                answer: { thread.answer(front, approved: $0) },
                                alwaysAllow: { thread.alwaysAllow(front) })
            }
            if let notice = thread.notice {
                HStack {
                    Text(notice).font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    Button { thread.notice = nil } label: { Image(systemName: "xmark") }.buttonStyle(.borderless)
                }
                .padding(.horizontal, 16).padding(.vertical, 4)
            }
            if let error = thread.error {
                ErrorNotice(error: error, canRetry: !thread.busy && thread.messages.contains { $0.role == "user" },
                            retry: { thread.retry() }, dismiss: { thread.error = nil })
            }
            McpConnectionBar(model: chat.mcp)
            QueuedMessages(thread: thread)
            ChatComposer(thread: thread, chat: chat)
        }
    }
}

/// The messages, sticking to the newest until the user scrolls up.
private struct ChatConversation: View {
    let thread: ChatThread
    @State private var pinned = true
    @State private var hovering = false
    @State private var wheelMonitor: Any?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(thread.messages.filter { $0.role == "user" || $0.role == "assistant" }) {
                        MessageRow(message: $0, thread: thread)
                    }
                    if thread.showsLive { liveTurn }
                    Color.clear.frame(height: 1).id("end")
                        .onAppear { pinned = true }
                }
                .padding(16)
            }
            .onHover { hovering = $0 }
            .onAppear {
                proxy.scrollTo("end", anchor: .bottom)
                installWheelMonitor()
            }
            .onDisappear { removeWheelMonitor() }
            .onChange(of: thread.live) { if pinned { proxy.scrollTo("end", anchor: .bottom) } }
            .onChange(of: thread.messages) { if pinned { proxy.scrollTo("end", anchor: .bottom) } }
            .overlay(alignment: .bottomTrailing) {
                if !pinned {
                    Button {
                        pinned = true
                        withAnimation { proxy.scrollTo("end", anchor: .bottom) }
                    } label: {
                        Image(systemName: "arrow.down").padding(8).background(.regularMaterial, in: Circle())
                    }
                    .buttonStyle(.plain).help("Scroll to newest").padding(12)
                }
            }
        }
    }

    @ViewBuilder private var liveTurn: some View {
        let live = thread.live
        VStack(alignment: .leading, spacing: 6) {
            Text("Yarvis").font(.caption.bold()).foregroundStyle(.secondary)
            if !live.tools.isEmpty || !live.reasoning.isEmpty {
                TurnActivity(tools: live.tools, reasoning: live.reasoning, reasoningLive: live.isReasoning,
                             reasoningSeconds: live.reasoningSeconds,
                             folded: !live.reply.isEmpty || !thread.busy)
            }
            if !live.reply.isEmpty {
                MarkdownText(live.reply)
            } else if thread.busy && live.isEmpty {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Thinking…").font(.callout).foregroundStyle(.secondary)
                }
            }
        }
    }

    /// Scrolling up with the wheel over the conversation releases the pin.
    /// Growth from streaming moves the end out of view too, so only the
    /// user's own scroll counts.
    private func installWheelMonitor() {
        guard wheelMonitor == nil else { return }
        let hover = $hovering
        let pin = $pinned
        wheelMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            MainActor.assumeIsolated {
                if hover.wrappedValue, event.scrollingDeltaY > 0 { pin.wrappedValue = false }
            }
            return event
        }
    }

    private func removeWheelMonitor() {
        if let wheelMonitor { NSEvent.removeMonitor(wheelMonitor) }
        wheelMonitor = nil
    }
}

/// A turn's failure: one line, the detail on demand, Retry and dismiss.
private struct ErrorNotice: View {
    let error: TurnFailure
    let canRetry: Bool
    let retry: () -> Void
    let dismiss: () -> Void
    @State private var showDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.red)
                Text(error.message).font(.callout).foregroundStyle(.red).textSelection(.enabled).lineLimit(2)
                Spacer()
                if error.detail != nil {
                    Button(showDetail ? "Hide details" : "Details") { showDetail.toggle() }
                }
                if canRetry { Button("Retry", action: retry) }
                Button(action: dismiss) { Image(systemName: "xmark") }.help("Dismiss")
            }
            .buttonStyle(.borderless)
            if showDetail, let detail = error.detail {
                HStack(alignment: .top) {
                    ScrollView {
                        Text(detail).font(.caption.monospaced()).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 140)
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString("\(error.message)\n\(detail)", forType: .string)
                    } label: { Image(systemName: "doc.on.doc") }
                        .buttonStyle(.borderless).help("Copy")
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 6)
        .background(.red.opacity(0.06))
    }
}

private struct QueuedMessages: View {
    let thread: ChatThread

    var body: some View {
        if !thread.queue.items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(thread.queueHeld ? "Queued — waiting until you send them" : "Queued — sends when the reply finishes")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if thread.queueHeld {
                        Button("Send next") { thread.sendNextQueued() }.controlSize(.small)
                    }
                }
                ForEach(Array(thread.queue.items.enumerated()), id: \.offset) { i, text in
                    HStack {
                        Text(text).lineLimit(2).font(.callout)
                        Spacer()
                        Button { thread.removeQueued(at: i) } label: { Image(systemName: "xmark") }
                            .buttonStyle(.borderless).help("Remove")
                    }
                    .padding(6)
                    .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 5))
                }
            }
            .padding(.horizontal, 16).padding(.top, 6)
        }
    }
}

/// The text box and its footer. Enter sends (or queues while a turn runs),
/// Shift+Enter starts a new line.
private struct ChatComposer: View {
    @Bindable var thread: ChatThread
    @Bindable var chat: ChatModel
    @FocusState private var focused: Bool

    private var hasText: Bool { !thread.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(spacing: 6) {
            ZStack(alignment: .topLeading) {
                // Sizes the box to its text, up to the frame's cap.
                Text(thread.draft.isEmpty ? " " : thread.draft + " ")
                    .font(.body).padding(.horizontal, 5).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .hidden()
                if thread.draft.isEmpty {
                    Text("Message...").foregroundStyle(.tertiary).padding(.horizontal, 5).padding(.vertical, 8)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $thread.draft)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(.vertical, 8)
                    .focused($focused)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        thread.submit()
                        return .handled
                    }
            }
            .frame(minHeight: 36, maxHeight: 180)
            .fixedSize(horizontal: false, vertical: true)
            .background(RoundedRectangle(cornerRadius: 8).fill(.background))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
            HStack(spacing: 10) {
                Toggle("Thinking", isOn: $chat.reasoningOn).toggleStyle(.checkbox).font(.caption)
                    .help("Ask the model to show its reasoning, when it can")
                ModelPicker(thread: thread, providers: chat.providers)
                Spacer()
                if thread.busy {
                    Button("Queue") { thread.enqueueDraft() }.disabled(!hasText)
                    Button("Stop", role: .destructive) { thread.stop() }
                        .keyboardShortcut(".", modifiers: .command)
                } else {
                    Button("Send") { thread.submit() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!hasText)
                }
            }
        }
        .padding(12)
        .onAppear { focused = true }
    }
}

private struct ModelPicker: View {
    let thread: ChatThread
    let providers: [ProviderInfo]

    var body: some View {
        Menu {
            ForEach(providers) { p in
                Menu(p.available ? p.label : "\(p.label) (no key)") {
                    ForEach(p.models, id: \.id) { m in
                        Button {
                            thread.choose(provider: p.id, model: m.id)
                        } label: {
                            if p.id == thread.provider && m.id == thread.model {
                                Label(m.id, systemImage: "checkmark")
                            } else {
                                Text(m.id)
                            }
                        }
                    }
                }
                .disabled(!p.available)
            }
        } label: {
            Text(label).font(.caption)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private var label: String {
        guard let model = thread.model else { return "No model" }
        let provider = providers.first { $0.id == thread.provider }?.label
        return provider.map { "\($0) · \(model)" } ?? model
    }
}

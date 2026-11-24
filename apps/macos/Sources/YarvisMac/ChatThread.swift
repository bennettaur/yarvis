import Foundation
import Observation
import YarvisClient

/// Reasoning kept for a turn that has just been saved. The sidecar doesn't
/// store it, so it only lasts until the tab opens another thread.
struct FinishedReasoning: Equatable {
    var text: String
    var seconds: Int?
}

/// One chat tab's thread and its turn in flight. Each tab has its own, so
/// background tabs keep streaming.
@MainActor @Observable
final class ChatThread: Identifiable {
    let id: String
    /// Weak because a turn's task can outlive the page after a sign-out.
    private weak var chat: ChatModel?
    private let client: YarvisClient

    private(set) var sessionId: String?
    private(set) var messages: [ChatMessage] = []
    /// The turn on screen: streaming, or failed with its tool activity kept.
    private(set) var live = LiveTurn()
    /// The live reply parsed for display, kept current by `flush`.
    private(set) var liveBlocks: [MarkdownBlock] = []
    /// The turn as it streams. `live` copies it at most every
    /// `deltaFlushInterval`, so a fast stream doesn't redraw on every token.
    @ObservationIgnored private var streaming = LiveTurn()
    @ObservationIgnored private var markdown = MarkdownStream()
    @ObservationIgnored private var flushPending = false
    /// True while the live turn's activity is on screen.
    private(set) var showsLive = false
    var busy: Bool { turn != nil }
    var error: TurnFailure?
    /// Something the user did, such as stopping a turn. Not an error.
    var notice: String?
    private(set) var queue = MessageQueue()
    var draft = ""
    private(set) var provider: String?
    private(set) var model: String?
    /// Reasoning of saved replies, by message id.
    private(set) var reasoning: [String: FinishedReasoning] = [:]

    private var turn: Task<Void, Never>?
    /// Which turn owns `live`, so a turn cancelled by opening another thread
    /// leaves that thread alone.
    private var turnId = UUID()
    /// Bumped on every load, so a slow load can't overwrite a newer one.
    private var loadId = UUID()

    init(id: String, sessionId: String?, chat: ChatModel, client: YarvisClient) {
        self.id = id
        self.chat = chat
        self.client = client
        self.sessionId = sessionId
        if let sessionId { Task { await loadMessages(sessionId) } }
    }

    private static let deltaFlushInterval: Duration = .milliseconds(50)

    var approvals: [ToolApprovalRequest] { live.approvals }
    var awaitingApproval: Bool { !live.approvals.isEmpty }
    var queueHeld: Bool { queue.held && !busy && !queue.items.isEmpty }

    // MARK: Threads

    /// Shows a saved thread, or an empty new chat for nil. Ignored mid-turn,
    /// so a reply is never thrown away by opening something else.
    func load(_ id: String?) {
        guard !busy else { return }
        turnId = UUID()
        sessionId = id
        messages = []
        resetLive()
        showsLive = false
        error = nil
        notice = nil
        reasoning = [:]
        queue.clear()
        if let id { Task { await loadMessages(id) } }
    }

    /// Reads the thread again when nothing is streaming into it.
    func reload() {
        guard let sessionId, !busy else { return }
        Task { await loadMessages(sessionId) }
    }

    private func loadMessages(_ id: String) async {
        let load = UUID()
        loadId = load
        do {
            let loaded = try await client.chatMessages(sessionId: id)
            guard loadId == load, sessionId == id else { return }
            messages = loaded
        } catch {
            if sessionId == id { self.error = TurnFailure(error) }
        }
    }

    // MARK: Model

    func choose(provider: String, model: String) {
        self.provider = provider
        self.model = model
        chat?.remember(provider: provider, model: model)
    }

    /// Fills in the model from the shared last pick once providers are known,
    /// and replaces one the server no longer offers.
    func adoptDefaultModel(_ pick: (provider: String, model: String)?) {
        let offered = chat?.providers.first { $0.id == provider }?.models.contains { $0.id == model } ?? false
        if !offered {
            provider = pick?.provider
            model = pick?.model
        }
    }

    // MARK: Sending

    /// The composer's Enter: sends, or queues while a turn runs or a queue
    /// is waiting, so messages go out in the order they were typed.
    func submit() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if busy || !queue.items.isEmpty {
            queue.enqueue(text)
            draft = ""
            return
        }
        draft = ""
        if !send(text) { draft = text }
    }

    func enqueueDraft() {
        if queue.enqueue(draft) { draft = "" }
    }

    func removeQueued(at index: Int) {
        queue.remove(at: index)
    }

    func sendNextQueued() {
        guard !busy, let next = queue.takeNext() else { return }
        if !send(next) { queue.sendRefused(next) }
    }

    /// Runs the last user message again after a failure, without a second bubble.
    func retry() {
        guard !busy, let last = messages.last(where: { $0.role == "user" }) else { return }
        send(last.content, resend: true)
    }

    /// Restarts the thread from a saved user message with `text`, the
    /// original or an edit.
    func rewind(to messageId: String, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, !trimmed.isEmpty,
              messages.contains(where: { $0.id == messageId && $0.role == "user" }) else { return }
        send(trimmed, rewindTo: messageId)
    }

    /// Starts a turn. False when it couldn't start, so the caller can put
    /// the text back.
    @discardableResult
    private func send(_ text: String, rewindTo: String? = nil, resend: Bool = false) -> Bool {
        guard !busy else { return false }
        guard let provider, let model else {
            error = TurnFailure(message: "No chat model is set up.",
                                detail: "Add a provider under Settings in the web UI, then pick it here.")
            return false
        }
        error = nil
        notice = nil
        queue.turnStarted()
        let id = UUID()
        turnId = id
        let reasoningOn = chat?.reasoningOn ?? false
        turn = Task {
            await runTurn(id: id, text: text, provider: provider, model: model, reasoning: reasoningOn,
                          rewindTo: rewindTo, resend: resend)
        }
        return true
    }

    func stop() {
        turn?.cancel()
    }

    private func runTurn(id: UUID, text: String, provider: String, model: String, reasoning: Bool,
                         rewindTo: String?, resend: Bool) async {
        defer { if turnId == id { turn = nil } }
        resetLive()
        showsLive = true
        var sessionId = self.sessionId
        do {
            if sessionId == nil {
                let created = try await client.createChatSession()
                sessionId = created.id
                if turnId == id {
                    self.sessionId = created.id
                    chat?.sessionCreated(created, inTab: self.id)
                }
            }
            guard let sessionId else { return }
            messages = messagesForTurn(messages, text: text, sessionId: sessionId, rewindTo: rewindTo, resend: resend)
            let stream = try client.sendChat(ChatTurn(sessionId: sessionId, message: text, provider: provider,
                                                      model: model, reasoning: reasoning, rewindTo: rewindTo))
            for try await event in stream where turnId == id {
                applyStreamed(event)
            }
            // Cancelling the consumer ends the stream without an error, so a
            // stop is told apart here.
            finish(id: id, sessionId: sessionId, cancelled: Task.isCancelled, rewound: rewindTo != nil)
        } catch let e as URLError where e.code == .cancelled {
            finish(id: id, sessionId: sessionId, cancelled: true, rewound: rewindTo != nil)
        } catch is CancellationError {
            finish(id: id, sessionId: sessionId, cancelled: true, rewound: rewindTo != nil)
        } catch {
            guard turnId == id else { return }
            streaming.fail(TurnFailure(error))
            flush()
            ended(failed: true, sessionId: sessionId, rewound: rewindTo != nil)
            self.error = TurnFailure(error)
        }
    }

    private func finish(id: UUID, sessionId: String?, cancelled: Bool, rewound: Bool) {
        guard turnId == id else { return }
        let outcome = streaming.finish(cancelled: cancelled)
        flush()
        switch outcome {
        case .stopped:
            notice = "Turn stopped. Nothing was saved for it."
            ended(failed: true, sessionId: sessionId, rewound: rewound)
        case .failed(let failure):
            error = failure
            ended(failed: true, sessionId: sessionId, rewound: rewound)
        case .saved:
            ended(failed: false, sessionId: sessionId, rewound: rewound)
        }
    }

    /// After any turn: hold the queue on a failure, read the saved thread
    /// back for its ids, and send the next queued message after a clean one.
    private func ended(failed: Bool, sessionId: String?, rewound: Bool) {
        queue.turnEnded(failed: failed)
        turn = nil
        guard let sessionId else { return }
        let finished = streaming
        let id = turnId
        Task {
            // A failed rewind may have left the screen and the sidecar
            // disagreeing about what was dropped, and a clean turn needs the
            // saved reply. A failure otherwise keeps the screen as it is.
            if !failed || rewound { await loadMessages(sessionId) }
            guard turnId == id, self.sessionId == sessionId else { return }
            if !failed {
                if !finished.reasoning.isEmpty, let reply = messages.last(where: { $0.role == "assistant" }) {
                    reasoning[reply.id] = FinishedReasoning(text: finished.reasoning, seconds: finished.reasoningSeconds)
                }
                resetLive()
                showsLive = false
            }
            chat?.turnFinished(sessionId: sessionId)
            if !failed, let next = queue.drain(), !send(next) { queue.sendRefused(next) }
        }
    }

    // MARK: Showing the live turn

    /// Text arrives in small pieces, so it waits for the next flush. Anything
    /// else, an approval most of all, shows at once.
    private func applyStreamed(_ event: ChatStreamEvent) {
        streaming.apply(event)
        switch event {
        case .delta, .reasoning:
            guard !flushPending else { return }
            flushPending = true
            Task {
                try? await Task.sleep(for: Self.deltaFlushInterval)
                flushPending = false
                flush()
            }
        default:
            flush()
        }
    }

    private func flush() {
        if live.reply != streaming.reply { liveBlocks = markdown.update(streaming.reply) }
        live = streaming
    }

    private func resetLive() {
        streaming = LiveTurn()
        markdown = MarkdownStream()
        liveBlocks = []
        live = streaming
    }

    // MARK: Approvals

    func answer(_ request: ToolApprovalRequest, approved: Bool) {
        streaming.answered(request.id)
        flush()
        guard let app = chat?.app else { return }
        Task {
            do {
                _ = try await app.withFreshCode { [client] in
                    try await client.answerToolApproval(id: request.id, approved: approved)
                }
            } catch {
                self.error = TurnFailure(error)
            }
        }
    }

    /// Approves this call and stops asking about the tool. The call is
    /// approved even when saving the preference fails, since the user said yes.
    func alwaysAllow(_ request: ToolApprovalRequest) {
        guard let toolId = request.toolId, toolId.hasPrefix("mcp:") else { return answer(request, approved: true) }
        streaming.answered(request.id)
        flush()
        guard let app = chat?.app else { return }
        Task {
            do {
                try await app.withFreshCode { [client] in try await client.alwaysAllowMcpTool(toolId) }
            } catch {
                self.error = TurnFailure(message: "Approved this call, but \"always allow\" wasn't saved: "
                    + error.localizedDescription)
            }
            do {
                _ = try await app.withFreshCode { [client] in
                    try await client.answerToolApproval(id: request.id, approved: true)
                }
            } catch {
                self.error = TurnFailure(error)
            }
        }
    }
}

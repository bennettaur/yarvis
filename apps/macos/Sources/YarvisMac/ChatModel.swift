import Foundation
import Observation
import YarvisClient

/// Chat threads and the turn in progress, as the web's `useChatThread` keeps them.
@MainActor @Observable
final class ChatModel {
    private unowned let app: AppModel
    private let client: YarvisClient

    var sessions: [ChatSession] = []
    var selectedId: String?
    var messages: [ChatMessage] = []
    var draft = ""
    var providers: [ProviderInfo] = []
    var provider: String?
    var model: String?
    /// The turn on screen: streaming, or failed with its tool activity kept.
    private(set) var live = LiveTurn()
    var reply: String { live.reply }
    var liveTools: [ToolActivity] { live.tools }
    var approvals: [ToolApprovalRequest] { live.approvals }
    var isStreaming: Bool { turn != nil }
    var error: String?
    /// Something the user did, such as stopping a turn. Not an error.
    var notice: String?

    private var turn: Task<Void, Never>?
    /// Which turn owns `live`, so a turn cancelled by opening another thread
    /// leaves that thread alone.
    private var turnId = UUID()
    private static let providerKey = "chat.provider"
    private static let modelKey = "chat.model"

    init(app: AppModel, client: YarvisClient) {
        self.app = app
        self.client = client
        reloadSessions()
        Task { await loadProviders() }
    }

    func stop() {
        turn?.cancel()
    }

    func handle(_ event: ServerEvent) {
        if event.kind == "sidecar.started" { reloadSessions() }
    }

    func resync() {
        reloadSessions()
    }

    /// Opens a thread asked for from another page, such as an attention item.
    func openSession(_ id: String) {
        open(id)
    }

    func reloadSessions() {
        Task {
            do {
                sessions = try await client.chatSessions()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func loadProviders() async {
        do {
            providers = try await client.chatProviders()
            let pick = defaultChatModel(providers,
                                        savedProvider: UserDefaults.standard.string(forKey: Self.providerKey),
                                        savedModel: UserDefaults.standard.string(forKey: Self.modelKey))
            provider = pick?.provider
            model = pick?.model
        } catch {
            self.error = error.localizedDescription
        }
    }

    func choose(provider: String, model: String) {
        self.provider = provider
        self.model = model
        UserDefaults.standard.set(provider, forKey: Self.providerKey)
        UserDefaults.standard.set(model, forKey: Self.modelKey)
    }

    func open(_ id: String?) {
        guard id != selectedId else { return }
        turn?.cancel()
        turnId = UUID()
        selectedId = id
        messages = []
        live = LiveTurn()
        error = nil
        notice = nil
        guard let id else { return }
        Task { await loadMessages(id) }
    }

    private func loadMessages(_ id: String) async {
        do {
            let loaded = try await client.chatMessages(sessionId: id)
            if selectedId == id { messages = loaded }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func newThread() {
        open(nil)
    }

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, turn == nil else { return }
        guard let provider, let model else {
            error = "No chat model is set up. Add a provider in the web UI's Settings."
            return
        }
        draft = ""
        error = nil
        notice = nil
        let id = UUID()
        turnId = id
        turn = Task { await runTurn(id: id, text: text, provider: provider, model: model) }
    }

    private func runTurn(id: UUID, text: String, provider: String, model: String) async {
        defer { if turnId == id { turn = nil } }
        do {
            let sessionId: String
            if let selectedId {
                sessionId = selectedId
            } else {
                let created = try await client.createChatSession()
                sessionId = created.id
                selectedId = created.id
                sessions.insert(created, at: 0)
            }
            messages.append(ChatMessage(id: "local-\(UUID())", sessionId: sessionId, role: "user", content: text,
                                        createdAt: ISO8601DateFormatter().string(from: Date())))
            live = LiveTurn()
            let stream = try client.sendChat(ChatTurn(sessionId: sessionId, message: text, provider: provider, model: model))
            for try await event in stream where turnId == id {
                live.apply(event)
            }
            // Cancelling the consumer ends the stream without an error, so a
            // stop is told apart here.
            finish(id: id, sessionId: sessionId, cancelled: Task.isCancelled)
        } catch let e as URLError where e.code == .cancelled {
            finish(id: id, sessionId: nil, cancelled: true)
        } catch is CancellationError {
            finish(id: id, sessionId: nil, cancelled: true)
        } catch {
            guard turnId == id else { return }
            _ = live.finish(cancelled: false)
            self.error = error.localizedDescription
        }
    }

    private func finish(id: UUID, sessionId: String?, cancelled: Bool) {
        guard turnId == id else { return }
        switch live.finish(cancelled: cancelled) {
        case .stopped:
            notice = "Stopped. Nothing was saved for that turn."
        case .failed(let reason):
            error = reason
        case .saved:
            guard let sessionId else { return }
            Task {
                await loadMessages(sessionId)
                if turnId == id { live = LiveTurn() }
                sessions = (try? await client.chatSessions()) ?? sessions
            }
        }
    }

    func answer(_ request: ToolApprovalRequest, approved: Bool) {
        live.answered(request.id)
        Task {
            do {
                _ = try await app.withFreshCode { [client] in
                    try await client.answerToolApproval(id: request.id, approved: approved)
                }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

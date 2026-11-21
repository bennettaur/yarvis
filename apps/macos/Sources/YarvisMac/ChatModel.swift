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
    /// The reply as it streams; dropped if the turn fails or is stopped.
    var reply = ""
    var liveTools: [ToolActivity] = []
    /// Tool calls waiting on the user, front first.
    var approvals: [ToolApprovalRequest] = []
    var isStreaming: Bool { turn != nil }
    var error: String?
    /// Something the user did, such as stopping a turn. Not an error.
    var notice: String?

    private var turn: Task<Void, Never>?
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
        selectedId = id
        messages = []
        reply = ""
        liveTools = []
        approvals = []
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
        turn = Task { await run(text: text, provider: provider, model: model) }
    }

    private func run(text: String, provider: String, model: String) async {
        defer { turn = nil }
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
                                        toolCalls: nil, createdAt: ISO8601DateFormatter().string(from: Date())))
            reply = ""
            liveTools = []
            var failed = false
            let stream = try client.sendChat(ChatTurn(sessionId: sessionId, message: text, provider: provider, model: model))
            for try await event in stream {
                switch event {
                case .delta(let t): reply += t
                case .toolCall(let call): liveTools.append(call)
                case .toolResult(let id, let status, let result, let ms):
                    if let i = liveTools.firstIndex(where: { $0.id == id }) {
                        liveTools[i].status = status
                        liveTools[i].result = result
                        liveTools[i].durationMs = ms
                    }
                case .approvalRequest(let request): approvals.append(request)
                case .error(let message, let detail):
                    failed = true
                    error = detail.map { "\(message) \($0)" } ?? message
                case .done, .reasoning, .attention, .ping, .unknown: break
                }
            }
            approvals = []
            // A failed turn saved no reply; its tool activity stays on screen.
            if failed { reply = "" }
            if !failed {
                await loadMessages(sessionId)
                reply = ""
                liveTools = []
            }
            sessions = (try? await client.chatSessions()) ?? sessions
        } catch is CancellationError {
            stopped()
        } catch let e as URLError where e.code == .cancelled {
            stopped()
        } catch {
            approvals = []
            self.error = error.localizedDescription
        }
    }

    /// The sidecar saves nothing for a stopped turn, so the partial reply goes too.
    private func stopped() {
        reply = ""
        approvals = []
        notice = "Stopped. Nothing was saved for that turn."
    }

    func answer(_ request: ToolApprovalRequest, approved: Bool) {
        approvals.removeAll { $0.id == request.id }
        Task {
            do {
                _ = try await app.fresh { [client] in
                    try await client.answerToolApproval(id: request.id, approved: approved)
                }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

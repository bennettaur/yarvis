import Foundation

/// What a chat turn sends (`POST /api/chat` on the sidecar).
public struct ChatTurn: Sendable {
    public var sessionId: String
    public var message: String
    public var provider: String
    public var model: String

    public init(sessionId: String, message: String, provider: String, model: String) {
        self.sessionId = sessionId
        self.message = message
        self.provider = provider
        self.model = model
    }
}

extension YarvisClient {
    public func chatSessions() async throws -> [ChatSession] {
        try await get([ChatSession].self, Self.sidecar("/api/chat/sessions"))
    }

    public func createChatSession(title: String? = nil) async throws -> ChatSession {
        try await post(ChatSession.self, Self.sidecar("/api/chat/sessions"),
                       body: .object(["title": title.map(JSONValue.string) ?? .null]))
    }

    public func chatMessages(sessionId: String) async throws -> [ChatMessage] {
        try await get([ChatMessage].self,
                      Self.sidecar("/api/chat/sessions/\(encodePathSegment(sessionId))/messages"))
    }

    public func chatProviders() async throws -> [ProviderInfo] {
        try await get([ProviderInfo].self, Self.sidecar("/api/chat/providers?capability=chat"))
    }

    /// Runs one turn and streams it. Cancel the consuming task to stop the
    /// turn: the sidecar sees the request end and saves nothing for it.
    public func sendChat(_ turn: ChatTurn) throws -> AsyncThrowingStream<ChatStreamEvent, Error> {
        let req = try request("POST", Self.sidecar("/api/chat"), body: .object([
            "sessionId": .string(turn.sessionId),
            "message": .string(turn.message),
            "provider": .string(turn.provider),
            "model": .string(turn.model),
        ]))
        let raw = eventStream(req)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await data in raw {
                        // An event this build can't parse is skipped rather
                        // than ending a turn that is otherwise fine.
                        if let event = try? ChatStreamEvent.decode(data) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Answers a tool approval from a chat turn. False means nothing was
    /// waiting on it any more (answered elsewhere, or the turn ended).
    @discardableResult
    public func answerToolApproval(id: String, approved: Bool) async throws -> Bool {
        struct Delivered: Decodable { var delivered: Bool }
        return try await post(Delivered.self,
                              Self.sidecar("/api/chat/approvals/\(encodePathSegment(id))"),
                              body: .object(["approved": .bool(approved)])).delivered
    }
}

/// Picks the provider and model for a new turn, as the web does: the saved
/// choice when the provider still offers it, else the first available
/// provider and its first model.
public func defaultChatModel(_ providers: [ProviderInfo], savedProvider: String?,
                             savedModel: String?) -> (provider: String, model: String)? {
    let chosen = providers.first { $0.id == savedProvider }
        ?? providers.first { $0.available }
        ?? providers.first
    guard let chosen else { return nil }
    let model = chosen.models.first { $0.id == savedModel } ?? chosen.models.first
    guard let model else { return nil }
    return (chosen.id, model.id)
}

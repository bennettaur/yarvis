import Foundation

/// What a chat turn sends (`POST /api/chat` on the sidecar).
public struct ChatTurn: Sendable {
    public var sessionId: String
    public var message: String
    public var provider: String
    public var model: String
    /// Asks a capable model for its reasoning, sent back as `reasoning` events.
    public var reasoning: Bool
    /// A saved user message to restart from: it and everything after it are
    /// dropped before this turn runs.
    public var rewindTo: String?

    public init(sessionId: String, message: String, provider: String, model: String,
                reasoning: Bool = false, rewindTo: String? = nil) {
        self.sessionId = sessionId
        self.message = message
        self.provider = provider
        self.model = model
        self.reasoning = reasoning
        self.rewindTo = rewindTo
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
        var body: [String: JSONValue] = [
            "sessionId": .string(turn.sessionId),
            "message": .string(turn.message),
            "provider": .string(turn.provider),
            "model": .string(turn.model),
        ]
        if turn.reasoning { body["reasoning"] = .bool(true) }
        if let rewindTo = turn.rewindTo { body["rewindTo"] = .string(rewindTo) }
        let req = try request("POST", Self.sidecar("/api/chat"), body: .object(body))
        return decodedEventStream(req, ChatStreamEvent.decode)
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

/// Picks the provider and model for a new turn: the saved choice when the
/// provider still offers it, else the first available provider and its
/// first model.
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

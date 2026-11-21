import Foundation

extension YarvisClient {
    /// Pending attention items, newest first.
    public func attentionItems() async throws -> [AttentionItem] {
        try await get([AttentionItem].self, Self.sidecar("/api/attention?status=pending"))
    }

    /// The live attention stream. It sends every change as a full row and
    /// replays nothing, so reload the list after it drops.
    public func attentionStream() throws -> AsyncThrowingStream<AttentionStreamEvent, Error> {
        let raw = eventStream(try request("GET", Self.sidecar("/api/attention/stream")))
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await data in raw {
                        if let event = try? AttentionStreamEvent.decode(data) {
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

    /// Marks an item `read`, `resolved` or `dismissed`.
    public func setAttentionStatus(id: String, _ status: String) async throws {
        try await send("PATCH", Self.sidecar("/api/attention/\(encodePathSegment(id))"),
                       body: .object(["status": .string(status)]))
    }

    public func permissionRequests(sessionKey: String? = nil) async throws -> [PermissionRequest] {
        var path = "/api/attention/permissions"
        if let sessionKey {
            path += "?sessionKey=\(sessionKey.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")"
        }
        return try await get([PermissionRequest].self, Self.sidecar(path))
    }

    /// Answers a Claude Code permission prompt. False means it stopped
    /// waiting (answered in the terminal, or timed out).
    @discardableResult
    public func answerPermission(id: String, _ decision: PermissionDecision) async throws -> Bool {
        do {
            try await send("POST", Self.sidecar("/api/attention/permissions/\(encodePathSegment(id))"),
                           body: decision.body)
            return true
        } catch YarvisError.http(status: 410, _, _) {
            return false
        }
    }

    /// The pending questions an item is about: the session's, or the one its
    /// payload names.
    public func questions(for item: AttentionItem) async throws -> [AgentQuestion] {
        if let key = item.sessionKey {
            let q = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
            return try await get([AgentQuestion].self, Self.sidecar("/api/questions?sessionKey=\(q)"))
        }
        guard let id = item.payload?["questionId"]?.stringValue else { return [] }
        let one = try await get(AgentQuestion.self, Self.sidecar("/api/questions/\(encodePathSegment(id))"))
        return one.status == "pending" ? [one] : []
    }

    public func answerQuestion(id: String, _ answers: [QuestionAnswer]) async throws {
        let body = try JSONDecoder().decode(JSONValue.self,
                                            from: JSONEncoder().encode(["answers": answers]))
        try await send("POST", Self.sidecar("/api/questions/\(encodePathSegment(id))/answer"), body: body)
    }

    public func declineQuestion(id: String) async throws {
        try await send("POST", Self.sidecar("/api/questions/\(encodePathSegment(id))/decline"))
    }
}

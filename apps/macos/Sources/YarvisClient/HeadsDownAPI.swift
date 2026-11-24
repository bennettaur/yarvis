import Foundation

extension YarvisClient {
    private static func headsDown(_ rest: String = "") -> String { sidecar("/api/heads-down\(rest)") }

    // MARK: The run

    public func headsDownState() async throws -> HeadsDownState {
        try await get(HeadsDownState.self, Self.headsDown())
    }

    /// Leaving `stopAt` out keeps the stop time of a run already going, rather than clearing it.
    public func startHeadsDown(focus: String, stopAt: String? = nil) async throws {
        var body: [String: JSONValue] = ["focus": .string(focus)]
        if let stopAt { body["stopAt"] = .string(stopAt) }
        try await send("POST", Self.headsDown("/start"), body: .object(body))
    }

    public func stopHeadsDown() async throws {
        try await send("POST", Self.headsDown("/stop"), body: .object([:]))
    }

    public func pauseHeadsDown() async throws {
        try await send("POST", Self.headsDown("/pause"), body: .object([:]))
    }

    public func resumeHeadsDown() async throws {
        try await send("POST", Self.headsDown("/resume"), body: .object([:]))
    }

    /// Drops every open work stream, deletes the user's messages and dismisses
    /// open questions. Refused while a run is going and not paused.
    public func clearHeadsDown() async throws {
        try await send("POST", Self.headsDown("/clear"), body: .object([:]))
    }

    /// Sets when the run stops on its own (an ISO timestamp), or clears it with nil.
    public func setHeadsDownStopAt(_ stopAt: String?) async throws {
        try await send("PUT", Self.headsDown("/stop-at"), body: .object(["stopAt": stopAt.map(JSONValue.string) ?? .null]))
    }

    // MARK: Settings

    public func headsDownConfig() async throws -> HeadsDownConfig {
        try await get(HeadsDownConfig.self, Self.headsDown("/config"))
    }

    public func saveHeadsDownConfig(_ config: HeadsDownConfig) async throws {
        try await send("PUT", Self.headsDown("/config"), body: config.body)
    }

    public func headsDownAllowedTools() async throws -> [HeadsDownAllowedTool] {
        try await get([HeadsDownAllowedTool].self, Self.headsDown("/allowed-tools"))
    }

    public func setHeadsDownToolAllowed(_ id: String, allowed: Bool) async throws {
        try await send("PUT", Self.headsDown("/allowed-tools/\(encodePathSegment(id))"),
                       body: .object(["allowed": .bool(allowed)]))
    }

    // MARK: Routines

    public func headsDownRoutines() async throws -> HeadsDownRoutines {
        try await get(HeadsDownRoutines.self, Self.headsDown("/routines"))
    }

    /// Reads the routine files again and returns what loaded.
    public func reloadHeadsDownRoutines() async throws -> HeadsDownRoutines {
        try await post(HeadsDownRoutines.self, Self.headsDown("/routines/reload"))
    }

    // MARK: Passes and messages

    /// Newest first.
    public func headsDownPasses() async throws -> [HeadsDownPass] {
        try await get([HeadsDownPass].self, Self.headsDown("/passes"))
    }

    /// A pass's transcript.
    public func headsDownPassMessages(id: String) async throws -> [HeadsDownPassMessage] {
        struct Pass: Decodable { var messages: [HeadsDownPassMessage] }
        return try await get(Pass.self, Self.headsDown("/passes/\(encodePathSegment(id))")).messages
    }

    public func headsDownMessages() async throws -> [HeadsDownMessage] {
        try await get([HeadsDownMessage].self, Self.headsDown("/messages"))
    }

    public func sendHeadsDownMessage(_ body: String) async throws {
        try await send("POST", Self.headsDown("/messages"), body: .object(["body": .string(body)]))
    }

    // MARK: Questions

    public func headsDownQuestions() async throws -> [HeadsDownQuestion] {
        try await get([HeadsDownQuestion].self, Self.headsDown("/questions"))
    }

    /// Calls the decision model approved on the user's behalf, newest first.
    public func headsDownAutoApprovals() async throws -> [HeadsDownQuestion] {
        try await get([HeadsDownQuestion].self, Self.headsDown("/auto-approvals"))
    }

    /// Answers with one of the offered `choice`s (`approve` or `deny` for an
    /// approval), or with the user's own words.
    public func answerHeadsDownQuestion(id: String, choice: String? = nil, answer: String? = nil) async throws {
        var body: [String: JSONValue] = [:]
        if let choice { body["choice"] = .string(choice) }
        if let answer { body["answer"] = .string(answer) }
        try await send("POST", Self.headsDown("/questions/\(encodePathSegment(id))/answer"), body: .object(body))
    }

    public func dismissHeadsDownQuestion(id: String) async throws {
        try await send("POST", Self.headsDown("/questions/\(encodePathSegment(id))/dismiss"), body: .object([:]))
    }

    // MARK: Work streams

    public func workStreams() async throws -> [WorkStream] {
        try await get([WorkStream].self, Self.sidecar("/api/work-streams"))
    }

    /// Changes a stream's `status` (`done`, `dropped`, …) or pauses it.
    public func updateWorkStream(id: String, status: String? = nil, paused: Bool? = nil) async throws {
        var body: [String: JSONValue] = [:]
        if let status { body["status"] = .string(status) }
        if let paused { body["paused"] = .bool(paused) }
        try await send("PATCH", Self.sidecar("/api/work-streams/\(encodePathSegment(id))"), body: .object(body))
    }

    // MARK: Live

    /// Live updates for the page. Forward only: after it drops, read the lists again.
    public func headsDownStream() throws -> AsyncThrowingStream<HeadsDownStreamEvent, Error> {
        decodedEventStream(try request("GET", Self.headsDown("/stream")), HeadsDownStreamEvent.decode)
    }
}

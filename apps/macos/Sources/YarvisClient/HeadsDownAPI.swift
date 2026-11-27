import Foundation

extension YarvisClient {
    private static func headsDownPath(_ rest: String = "") -> String { sidecar("/api/heads-down\(rest)") }

    // MARK: The run

    public func headsDownState() async throws -> HeadsDownState {
        try await get(HeadsDownState.self, Self.headsDownPath())
    }

    /// Leaving `stopAt` out keeps the stop time of a run already going, rather than clearing it.
    public func startHeadsDown(focus: String, stopAt: String? = nil) async throws {
        var body: [String: JSONValue] = ["focus": .string(focus)]
        if let stopAt { body["stopAt"] = .string(stopAt) }
        try await send("POST", Self.headsDownPath("/start"), body: .object(body))
    }

    public func stopHeadsDown() async throws {
        try await send("POST", Self.headsDownPath("/stop"), body: .object([:]))
    }

    public func pauseHeadsDown() async throws {
        try await send("POST", Self.headsDownPath("/pause"), body: .object([:]))
    }

    public func resumeHeadsDown() async throws {
        try await send("POST", Self.headsDownPath("/resume"), body: .object([:]))
    }

    /// Drops every open work stream, deletes the user's messages and dismisses
    /// open questions. Refused while a run is going and not paused.
    public func clearHeadsDown() async throws {
        try await send("POST", Self.headsDownPath("/clear"), body: .object([:]))
    }

    /// Sets when the run stops on its own (an ISO timestamp), or clears it with nil.
    public func setHeadsDownStopAt(_ stopAt: String?) async throws {
        try await send("PUT", Self.headsDownPath("/stop-at"), body: .object(["stopAt": stopAt.map(JSONValue.string) ?? .null]))
    }

    // MARK: Settings

    public func headsDownConfig() async throws -> HeadsDownConfig {
        try await get(HeadsDownConfig.self, Self.headsDownPath("/config"))
    }

    public func saveHeadsDownConfig(_ config: HeadsDownConfig) async throws {
        try await send("PUT", Self.headsDownPath("/config"), body: config.body)
    }

    public func headsDownAllowedTools() async throws -> [HeadsDownAllowedTool] {
        try await get([HeadsDownAllowedTool].self, Self.headsDownPath("/allowed-tools"))
    }

    public func setHeadsDownToolAllowed(_ id: String, allowed: Bool) async throws {
        try await send("PUT", Self.headsDownPath("/allowed-tools/\(encodePathSegment(id))"),
                       body: .object(["allowed": .bool(allowed)]))
    }

    // MARK: Routines

    public func headsDownRoutines() async throws -> HeadsDownRoutines {
        try await get(HeadsDownRoutines.self, Self.headsDownPath("/routines"))
    }

    /// Reads the routine files again and returns what loaded.
    public func reloadHeadsDownRoutines() async throws -> HeadsDownRoutines {
        try await post(HeadsDownRoutines.self, Self.headsDownPath("/routines/reload"))
    }

    /// Writes a new routine file to the user's folder. A refusal (a taken
    /// name, a bad cadence) throws with the server's reason.
    public func createHeadsDownRoutine(_ routine: NewHeadsDownRoutine) async throws -> HeadsDownRoutines {
        try await post(HeadsDownRoutines.self, Self.headsDownPath("/routines"), body: routine.requestBody)
    }

    /// The user's switch for a routine, kept in the heads-down settings; no file is written.
    public func setHeadsDownRoutineEnabled(name: String, enabled: Bool) async throws -> HeadsDownRoutines {
        try Self.decode(HeadsDownRoutines.self, await send(
            "PUT", Self.headsDownPath("/routines/\(encodePathSegment(name))/enabled"),
            body: .object(["enabled": .bool(enabled)])))
    }

    /// Deletes the user's own routine file. A shipped routine is refused.
    public func deleteHeadsDownRoutine(name: String) async throws -> HeadsDownRoutines {
        try Self.decode(HeadsDownRoutines.self, await send("DELETE", Self.headsDownPath("/routines/\(encodePathSegment(name))")))
    }

    // MARK: Passes and messages

    /// Newest first.
    public func headsDownPasses() async throws -> [HeadsDownPass] {
        try await get([HeadsDownPass].self, Self.headsDownPath("/passes"))
    }

    /// A pass's transcript.
    public func headsDownPassMessages(id: String) async throws -> [HeadsDownPassMessage] {
        struct Pass: Decodable { var messages: [HeadsDownPassMessage] }
        return try await get(Pass.self, Self.headsDownPath("/passes/\(encodePathSegment(id))")).messages
    }

    public func headsDownMessages() async throws -> [HeadsDownMessage] {
        try await get([HeadsDownMessage].self, Self.headsDownPath("/messages"))
    }

    public func sendHeadsDownMessage(_ body: String) async throws {
        try await send("POST", Self.headsDownPath("/messages"), body: .object(["body": .string(body)]))
    }

    // MARK: Questions

    public func headsDownQuestions() async throws -> [HeadsDownQuestion] {
        try await get([HeadsDownQuestion].self, Self.headsDownPath("/questions"))
    }

    /// Calls the decision model approved on the user's behalf, newest first.
    public func headsDownAutoApprovals() async throws -> [HeadsDownQuestion] {
        try await get([HeadsDownQuestion].self, Self.headsDownPath("/auto-approvals"))
    }

    /// Answers with one of the offered `choice`s (`approve` or `deny` for an
    /// approval), or with the user's own words.
    public func answerHeadsDownQuestion(id: String, choice: String? = nil, answer: String? = nil) async throws {
        var body: [String: JSONValue] = [:]
        if let choice { body["choice"] = .string(choice) }
        if let answer { body["answer"] = .string(answer) }
        try await send("POST", Self.headsDownPath("/questions/\(encodePathSegment(id))/answer"), body: .object(body))
    }

    public func dismissHeadsDownQuestion(id: String) async throws {
        try await send("POST", Self.headsDownPath("/questions/\(encodePathSegment(id))/dismiss"), body: .object([:]))
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
        decodedEventStream(try request("GET", Self.headsDownPath("/stream")), HeadsDownStreamEvent.decode)
    }
}

/// One read of the page's lists. A list whose read failed is nil, so the page
/// keeps what it was showing for it.
public struct HeadsDownLoad: Sendable {
    public var state: HeadsDownState?
    public var questions: [HeadsDownQuestion]?
    public var streams: [WorkStream]?
    public var passes: [HeadsDownPass]?
    public var messages: [HeadsDownMessage]?
    public var autoApprovals: [HeadsDownQuestion]?
    public var routines: HeadsDownRoutines?
    /// Why the first of the main lists (state, questions, streams, passes,
    /// messages) failed. Auto-approvals only add to the page, so a failed read
    /// of them leaves the last list up without an error; routines show their
    /// own error in place of the list.
    public var failure: String?
    public var routinesFailure: String?

    /// Reads every list at once.
    public static func read(_ client: YarvisClient) async -> HeadsDownLoad {
        async let state = outcome { try await client.headsDownState() }
        async let questions = outcome { try await client.headsDownQuestions() }
        async let streams = outcome { try await client.workStreams() }
        async let passes = outcome { try await client.headsDownPasses() }
        async let messages = outcome { try await client.headsDownMessages() }
        async let approvals = outcome { try await client.headsDownAutoApprovals() }
        async let routines = outcome { try await client.headsDownRoutines() }

        var load = HeadsDownLoad()
        var failures: [String] = []
        func main<T>(_ r: Result<T, Error>) -> T? {
            if case .failure(let e) = r { failures.append(e.localizedDescription) }
            return try? r.get()
        }
        load.state = main(await state)
        load.questions = main(await questions)
        load.streams = main(await streams)
        load.passes = main(await passes)
        load.messages = main(await messages)
        load.failure = failures.first
        load.autoApprovals = try? (await approvals).get()
        switch await routines {
        case .success(let r): load.routines = r
        case .failure(let e): load.routinesFailure = e.localizedDescription
        }
        return load
    }
}

private func outcome<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, Error> {
    do {
        return .success(try await body())
    } catch {
        return .failure(error)
    }
}

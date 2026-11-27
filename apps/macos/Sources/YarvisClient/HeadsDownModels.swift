import Foundation

// Heads-down mode (sidecar `headsDown/routes.ts`) and the work streams it
// pushes (`/api/work-streams`). Field names follow the sidecar's rows.

public struct HeadsDownRun: Codable, Sendable, Equatable {
    public var id: String
    public var focus: String?
    /// `active` or `stopped`.
    public var status: String
    public var startedAt: String
    public var stoppedAt: String?
    /// Set while the user has paused it: no passes run until they resume.
    public var pausedAt: String?
    /// When it stops on its own, if the user set a time.
    public var stopAt: String?

    public init(id: String, focus: String? = nil, status: String = "active", startedAt: String,
                stoppedAt: String? = nil, pausedAt: String? = nil, stopAt: String? = nil) {
        self.id = id
        self.focus = focus
        self.status = status
        self.startedAt = startedAt
        self.stoppedAt = stoppedAt
        self.pausedAt = pausedAt
        self.stopAt = stopAt
    }
}

public struct HeadsDownFailedCall: Codable, Sendable, Equatable {
    public var name: String
    public var server: String?
    public var error: String?
    /// The call's result never came back.
    public var noResult: Bool?
}

public struct HeadsDownPass: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var runId: String
    public var chatSessionId: String?
    public var startedAt: String
    public var finishedAt: String?
    public var notes: String?
    public var sleepMinutes: Double?
    public var sleepReason: String?
    public var error: String?
    /// Only on the pass list.
    public var callCount: Int?
    /// Only on the pass list.
    public var failedCalls: [HeadsDownFailedCall]?

    public init(id: String, runId: String, startedAt: String, finishedAt: String? = nil,
                notes: String? = nil, sleepMinutes: Double? = nil, sleepReason: String? = nil,
                error: String? = nil, callCount: Int? = nil, failedCalls: [HeadsDownFailedCall]? = nil) {
        self.id = id
        self.runId = runId
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.notes = notes
        self.sleepMinutes = sleepMinutes
        self.sleepReason = sleepReason
        self.error = error
        self.callCount = callCount
        self.failedCalls = failedCalls
    }
}

/// The model passes run on, as the run header names it.
public struct HeadsDownPassModel: Codable, Sendable, Equatable {
    public var provider: String
    public var model: String
    /// `saved` when set in Settings, `default` for the default chat model.
    public var source: String

    public init(provider: String, model: String, source: String) {
        self.provider = provider
        self.model = model
        self.source = source
    }
}

public struct HeadsDownState: Codable, Sendable, Equatable {
    public var run: HeadsDownRun?
    public var lastPass: HeadsDownPass?
    public var nextPassAt: String?
    public var openQuestionCount: Int
    /// Nil when no model is usable.
    public var model: HeadsDownPassModel?

    public init(run: HeadsDownRun?, lastPass: HeadsDownPass? = nil, nextPassAt: String? = nil,
                openQuestionCount: Int = 0, model: HeadsDownPassModel? = nil) {
        self.run = run
        self.lastPass = lastPass
        self.nextPassAt = nextPassAt
        self.openQuestionCount = openQuestionCount
        self.model = model
    }
}

/// Something a pass is waiting on the user for: a question, or approval of one tool call.
public struct HeadsDownQuestion: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    /// `question` or `approval`.
    public var kind: String
    public var streamId: String?
    public var question: String
    public var situation: String?
    public var options: [String]
    /// For an approval, the tool's registry id, such as `mcp:<server>:<tool>`.
    public var action: String?
    public var toolArgs: JSONValue?
    /// `open`, `answered` or `dismissed`.
    public var status: String
    public var choice: String?
    public var answer: String?
    /// `user` or `decision-model`; nil until answered.
    public var answeredBy: String?
    public var createdAt: String
    public var answeredAt: String?

    public init(id: String, kind: String = "question", question: String, situation: String? = nil,
                options: [String] = [], action: String? = nil, toolArgs: JSONValue? = nil,
                status: String = "open", answer: String? = nil, createdAt: String, answeredAt: String? = nil) {
        self.id = id
        self.kind = kind
        self.question = question
        self.situation = situation
        self.options = options
        self.action = action
        self.toolArgs = toolArgs
        self.status = status
        self.answer = answer
        self.createdAt = createdAt
        self.answeredAt = answeredAt
    }

    public var isApproval: Bool { kind == "approval" }

    /// The MCP tool an approval would call, which the user can allow for good.
    public var mcpTool: String? {
        guard isApproval, let action, action.hasPrefix("mcp:") else { return nil }
        return action
    }

    /// The tool part of `mcpTool`'s `mcp:<server>:<tool>`.
    public var mcpToolName: String? {
        mcpTool.map { $0.split(separator: ":", maxSplits: 2).last.map(String.init) ?? $0 }
    }
}

public struct HeadsDownMessage: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var body: String
    public var createdAt: String
    public var seenAt: String?
}

public struct WorkingHours: Codable, Sendable, Equatable {
    /// 0 is Sunday.
    public var days: [Int]
    /// "HH:MM".
    public var start: String
    public var end: String

    public init(days: [Int], start: String, end: String) {
        self.days = days
        self.start = start
        self.end = end
    }

    public static let standard = WorkingHours(days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00")
}

public struct HeadsDownConfig: Codable, Sendable, Equatable {
    public var minSleepMinutes: Int
    public var maxSleepMinutes: Int
    public var idleSleepMinutes: Int
    /// Nil means any time is fine to tag people.
    public var workingHours: WorkingHours?
    public var userAwayAfterMinutes: Int
    public var passTimeoutMinutes: Int
    /// Nil runs passes on the default chat model.
    public var provider: String?
    public var model: String?
    public var guidance: String?
    /// 0 turns routines off.
    public var maxRoutinesPerPass: Int

    /// The defaults are the sidecar's (`DEFAULT_HEADS_DOWN_CONFIG`).
    public init(minSleepMinutes: Int = 5, maxSleepMinutes: Int = 120, idleSleepMinutes: Int = 60,
                workingHours: WorkingHours? = .standard, userAwayAfterMinutes: Int = 120,
                passTimeoutMinutes: Int = 20, provider: String? = nil, model: String? = nil,
                guidance: String? = nil, maxRoutinesPerPass: Int = 2) {
        self.minSleepMinutes = minSleepMinutes
        self.maxSleepMinutes = maxSleepMinutes
        self.idleSleepMinutes = idleSleepMinutes
        self.workingHours = workingHours
        self.userAwayAfterMinutes = userAwayAfterMinutes
        self.passTimeoutMinutes = passTimeoutMinutes
        self.provider = provider
        self.model = model
        self.guidance = guidance
        self.maxRoutinesPerPass = maxRoutinesPerPass
    }

    /// The PUT body. Nulls are sent rather than left out, since a missing
    /// `workingHours` or `provider` is refused rather than kept.
    var body: JSONValue {
        func optional(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }
        func number(_ n: Int) -> JSONValue { .number(Double(n)) }
        let hours: JSONValue = workingHours.map {
            .object(["days": .array($0.days.map(number)), "start": .string($0.start), "end": .string($0.end)])
        } ?? .null
        return .object([
            "minSleepMinutes": number(minSleepMinutes),
            "maxSleepMinutes": number(maxSleepMinutes),
            "idleSleepMinutes": number(idleSleepMinutes),
            "workingHours": hours,
            "userAwayAfterMinutes": number(userAwayAfterMinutes),
            "passTimeoutMinutes": number(passTimeoutMinutes),
            "provider": optional(provider),
            "model": optional(model),
            "guidance": optional(guidance),
            "maxRoutinesPerPass": number(maxRoutinesPerPass),
        ])
    }
}

/// A routine `config:` setting: one value or a list.
public enum HeadsDownRoutineSetting: Codable, Sendable, Equatable {
    case one(String)
    case many([String])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let list = try? c.decode([String].self) {
            self = .many(list)
        } else {
            self = .one(try c.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .one(let s): try c.encode(s)
        case .many(let list): try c.encode(list)
        }
    }

    /// As the page shows it: a list joined with commas.
    public var text: String {
        switch self {
        case .one(let s): return s
        case .many(let list): return list.joined(separator: ", ")
        }
    }
}

/// A recurring job a pass takes on beside the work streams, read from a markdown file.
public struct HeadsDownRoutine: Codable, Sendable, Equatable {
    public var name: String
    public var description: String
    public var everyMinutes: Int
    public var workingHoursOnly: Bool
    /// `run`, `slow` or `skip`: what it does during night shift.
    public var nightShift: String
    /// Whether it runs: the user's switch, else `enabledByDefault`.
    public var enabled: Bool
    /// Its file's `enabled`. Optional so a server from before the switches still decodes.
    public var enabledByDefault: Bool?
    /// The user's switch in the heads-down settings; nil when the file's default decides.
    public var switchedTo: Bool?
    /// A one-off: offered until a pass reports it done, then its file is removed.
    public var once: Bool
    /// `builtin`, or `user` for a file in the user's own folder.
    public var source: String
    /// The user's file; nil for a shipped routine.
    public var path: String?
    public var tools: [String]
    public var config: [String: HeadsDownRoutineSetting]
    /// What a pass is told to do.
    public var body: String
    public var lastDoneAt: String?
    /// The next pass would be given it, if it started now.
    public var nextPass: Bool
    /// Due, but waiting for a free slot on a later pass.
    public var queued: Bool
    public var dueAt: String?
    /// `off`, `working-hours`, `night-shift` or `retry`: why a pass can't be given it now.
    public var heldBy: String?

    public init(name: String, description: String = "", everyMinutes: Int = 60, workingHoursOnly: Bool = false,
                nightShift: String = "run", enabled: Bool = true, enabledByDefault: Bool? = true,
                switchedTo: Bool? = nil, once: Bool = false, source: String = "builtin", path: String? = nil,
                tools: [String] = [], config: [String: HeadsDownRoutineSetting] = [:], body: String = "",
                lastDoneAt: String? = nil, nextPass: Bool = false, queued: Bool = false, dueAt: String? = nil,
                heldBy: String? = nil) {
        self.name = name
        self.description = description
        self.everyMinutes = everyMinutes
        self.workingHoursOnly = workingHoursOnly
        self.nightShift = nightShift
        self.enabled = enabled
        self.enabledByDefault = enabledByDefault
        self.switchedTo = switchedTo
        self.once = once
        self.source = source
        self.path = path
        self.tools = tools
        self.config = config
        self.body = body
        self.lastDoneAt = lastDoneAt
        self.nextPass = nextPass
        self.queued = queued
        self.dueAt = dueAt
        self.heldBy = heldBy
    }
}

public struct HeadsDownRoutines: Codable, Sendable, Equatable {
    public struct Problem: Codable, Sendable, Equatable {
        public var path: String
        public var message: String
    }

    public var routines: [HeadsDownRoutine]
    /// Files that couldn't be read as a routine, with why.
    public var problems: [Problem]
    /// Where the user's own routine files go.
    public var userDir: String
    /// The most routines one pass takes on. 0 turns them all off.
    public var maxRoutinesPerPass: Int

    public init(routines: [HeadsDownRoutine], problems: [Problem] = [], userDir: String = "",
                maxRoutinesPerPass: Int = 2) {
        self.routines = routines
        self.problems = problems
        self.userDir = userDir
        self.maxRoutinesPerPass = maxRoutinesPerPass
    }
}

/// A routine the user writes on the page, saved to their routines folder.
public struct NewHeadsDownRoutine: Sendable, Equatable {
    public enum Schedule: Sendable, Equatable {
        /// Such as `30m`, `3h` or `1d`.
        case every(String)
        case once
    }

    public var name: String
    public var description: String
    public var schedule: Schedule
    public var workingHours: Bool
    /// `run`, `slow` or `skip`.
    public var nightShift: String
    public var tools: [String]
    public var body: String

    public init(name: String, description: String, schedule: Schedule, workingHours: Bool = false,
                nightShift: String = "run", tools: [String] = [], body: String) {
        self.name = name
        self.description = description
        self.schedule = schedule
        self.workingHours = workingHours
        self.nightShift = nightShift
        self.tools = tools
        self.body = body
    }

    /// The POST body, shaped as the web form sends it: what is at its default is left out.
    var requestBody: JSONValue {
        var o: [String: JSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
            "description": .string(description.trimmingCharacters(in: .whitespacesAndNewlines)),
            "body": .string(body),
        ]
        switch schedule {
        case .every(let every): o["every"] = .string(every.trimmingCharacters(in: .whitespacesAndNewlines))
        case .once: o["once"] = .bool(true)
        }
        if workingHours { o["workingHours"] = .bool(true) }
        if nightShift != "run" { o["nightShift"] = .string(nightShift) }
        if !tools.isEmpty { o["tools"] = .array(tools.map(JSONValue.string)) }
        return .object(o)
    }
}

/// An MCP tool heads-down mode may call without asking.
public struct HeadsDownAllowedTool: Codable, Sendable, Identifiable, Equatable {
    /// `mcp:<server>:<tool>`.
    public var id: String
    public var name: String
}

// MARK: - Work streams

/// What a work stream link points at.
public enum WorkStreamLinkRef: Sendable, Equatable {
    case ticket(key: String, url: String?)
    case workspace(id: String)
    case pr(url: String)
    case message(conversation: String)
    case reviewRequest(conversation: String, sentAt: String)
    /// A kind this build doesn't know.
    case other(kind: String)
}

extension WorkStreamLinkRef: Decodable {
    public init(from decoder: Decoder) throws {
        let v = try JSONValue(from: decoder)
        func s(_ k: String) -> String { v[k]?.stringValue ?? "" }
        switch v["kind"]?.stringValue ?? "" {
        case "ticket": self = .ticket(key: s("key"), url: v["url"]?.stringValue)
        case "workspace": self = .workspace(id: s("workspaceId"))
        case "pr": self = .pr(url: s("url"))
        case "message": self = .message(conversation: s("conversation"))
        case "review-request": self = .reviewRequest(conversation: s("conversation"), sentAt: s("sentAt"))
        case let kind: self = .other(kind: kind)
        }
    }
}

public struct WorkStreamLink: Decodable, Sendable, Identifiable, Equatable {
    public var id: String
    public var ref: WorkStreamLinkRef
    public var title: String?
    public var state: String?

    public init(id: String, ref: WorkStreamLinkRef, title: String? = nil, state: String? = nil) {
        self.id = id
        self.ref = ref
        self.title = title
        self.state = state
    }
}

public struct WorkStream: Decodable, Sendable, Identifiable, Equatable {
    public var id: String
    public var title: String
    public var summary: String?
    /// `active`, `waiting-on-user`, `waiting-on-others`, `done` or `dropped`.
    public var status: String
    /// `urgent`, `high`, `medium` or `low`.
    public var priority: String
    public var nextAction: String?
    public var waitingOn: String?
    public var wakeAt: String?
    /// Set while the user has paused it: heads-down mode leaves it alone.
    public var pausedAt: String?
    public var updatedAt: String
    public var links: [WorkStreamLink]
}

/// A pass's transcript row: the prompt it started from, or what it did and said.
public struct HeadsDownPassMessage: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    /// `user`, `assistant` or `system`.
    public var role: String
    public var content: String
    public var toolCalls: [ToolActivity]?
    public var createdAt: String
}

// MARK: - The live stream

/// One message on `/api/heads-down/stream`.
public enum HeadsDownStreamEvent: Sendable, Equatable {
    case passStarted(passId: String)
    /// One update from the pass in flight, in the chat stream's shape.
    case passEvent(passId: String, event: ChatStreamEvent)
    case passRetrying(passId: String)
    case passFinished(passId: String)
    /// Something the page lists may have changed.
    case changed
    case ping
    case unknown

    public static func decode(_ json: Data) throws -> HeadsDownStreamEvent {
        let v = try JSONDecoder().decode(JSONValue.self, from: json)
        let passId = v["passId"]?.stringValue ?? ""
        switch v["type"]?.stringValue {
        case "pass-started": return .passStarted(passId: passId)
        case "pass-event":
            guard let inner = v["event"] else { return .unknown }
            return .passEvent(passId: passId, event: try ChatStreamEvent.decode(JSONEncoder().encode(inner)))
        case "pass-retrying": return .passRetrying(passId: passId)
        case "pass-finished": return .passFinished(passId: passId)
        case "changed": return .changed
        case "ping": return .ping
        default: return .unknown
        }
    }
}

// MARK: - Merges, from attention items

/// A pass's own risk rating for a merge.
public enum MergeRisk: String, Sendable, Equatable, CaseIterable {
    case low, medium, high, unknown
}

/// A merge a pass announced, carried on its attention item's payload.
public struct MergeAnnouncement: Sendable, Equatable {
    /// "owner/repo", or empty when the merge call didn't name one.
    public var repo: String
    /// Nil when a workspace's session was told to merge and the PR isn't known.
    public var number: Int?
    public var title: String?
    public var risk: MergeRisk
    public var why: String
}

/// An unresolved review thread on a PR heads-down mode wants to merge.
/// Author and body are third-party text.
public struct FeedbackThread: Decodable, Sendable, Equatable {
    public var path: String?
    public var line: Int?
    /// The code the thread was left on has since changed.
    public var outdated: Bool
    public var author: String
    public var body: String
    public var replies: Int
}

extension FeedbackThread {
    private enum CodingKeys: String, CodingKey { case path, line, outdated, author, body, replies }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decodeIfPresent(String.self, forKey: .path)
        line = try c.decodeIfPresent(Int.self, forKey: .line)
        outdated = try c.decodeIfPresent(Bool.self, forKey: .outdated) ?? false
        author = try c.decodeIfPresent(String.self, forKey: .author) ?? "someone"
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        replies = try c.decodeIfPresent(Int.self, forKey: .replies) ?? 0
    }
}

public struct PrFeedback: Decodable, Sendable, Equatable {
    public var repo: String
    public var number: Int
    public var title: String?
    public var workspaceId: String?
    /// Heads-down mode told the workspace's session to address the feedback.
    public var handedOff: Bool
    /// The first few unresolved threads; `threadCount` counts them all.
    public var threads: [FeedbackThread]
    public var threadCount: Int
    public var threadsTruncated: Bool
    public var changesRequestedBy: [String]
    /// Some of the feedback may be from outside the repo, so it wasn't handed on.
    public var fromOutsiders: Bool

    public init(repo: String, number: Int, title: String? = nil, workspaceId: String? = nil,
                handedOff: Bool = false, threads: [FeedbackThread] = [], threadCount: Int = 0,
                threadsTruncated: Bool = false, changesRequestedBy: [String] = [], fromOutsiders: Bool = false) {
        self.repo = repo
        self.number = number
        self.title = title
        self.workspaceId = workspaceId
        self.handedOff = handedOff
        self.threads = threads
        self.threadCount = threadCount
        self.threadsTruncated = threadsTruncated
        self.changesRequestedBy = changesRequestedBy
        self.fromOutsiders = fromOutsiders
    }

    private enum CodingKeys: String, CodingKey {
        case repo, number, title, workspaceId, handedOff, threads, threadCount, threadsTruncated
        case changesRequestedBy, fromOutsiders
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        repo = try c.decode(String.self, forKey: .repo)
        number = try c.decode(Int.self, forKey: .number)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
        handedOff = try c.decodeIfPresent(Bool.self, forKey: .handedOff) ?? false
        threads = try c.decode([FeedbackThread].self, forKey: .threads)
        threadCount = try c.decodeIfPresent(Int.self, forKey: .threadCount) ?? threads.count
        threadsTruncated = try c.decodeIfPresent(Bool.self, forKey: .threadsTruncated) ?? false
        changesRequestedBy = try c.decode([String].self, forKey: .changesRequestedBy)
        fromOutsiders = try c.decodeIfPresent(Bool.self, forKey: .fromOutsiders) ?? false
    }
}

/// A merge held back for open review feedback, waiting on the user's approval.
public struct MergeReview: Decodable, Sendable, Equatable {
    public var questionId: String
    public var prs: [PrFeedback]
    /// Why the feedback couldn't be checked, when it couldn't.
    public var unchecked: String?
}

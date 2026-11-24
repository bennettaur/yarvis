import Foundation

// The Review page's JSON shapes, from the sidecar's `reviewWorkspaces/`
// routes and the web client's `src/lib/reviewWorkspaces/*.ts`. Statuses stay
// strings where the sidecar may add a value this build hasn't seen.

/// A PR in a review workspace: its checkout and setup state.
public struct ReviewWorkspacePr: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var workspaceId: String
    public var refKey: String
    public var ref: PrRef
    public var title: String
    public var author: String?
    public var headRef: String?
    public var baseRef: String?
    /// Stable per workspace: the lowest index unused when the PR was added.
    public var colorIndex: Int
    public var position: Int
    /// "pending", "cloning", "ready" or "error". `ready` once the PR's
    /// commits are fetched, which every review read needs.
    public var status: String
    /// Why the last clone, refresh or checkout failed. A failed refresh stays `ready`.
    public var error: String?
    public var worktreePath: String
    /// "pending", "checking-out", "ready" or "error". Only setup and code
    /// navigation wait for it.
    public var worktreeStatus: String
    public var headSha: String?
    public var baseSha: String?
    public var mergeBaseSha: String?
    /// "granted", "declined", or nil before the user answered.
    public var setupConsent: String?
    /// The commit consent was given for; a new head asks again.
    public var setupHeadSha: String?
    /// "running", "succeeded", "failed" or "skipped".
    public var setupStatus: String?
    /// Absent from the list's rows.
    public var setupLog: String?
    public var addedAt: String

    public init(id: String, workspaceId: String, ref: PrRef, title: String, colorIndex: Int = 0, position: Int = 0,
                status: String = "ready", error: String? = nil, worktreePath: String = "",
                worktreeStatus: String = "ready", headSha: String? = nil, baseSha: String? = nil,
                mergeBaseSha: String? = nil, setupConsent: String? = nil, setupHeadSha: String? = nil,
                setupStatus: String? = nil, setupLog: String? = nil, author: String? = nil, headRef: String? = nil,
                baseRef: String? = nil, addedAt: String = "") {
        self.id = id
        self.workspaceId = workspaceId
        self.refKey = ref.key
        self.ref = ref
        self.title = title
        self.author = author
        self.headRef = headRef
        self.baseRef = baseRef
        self.colorIndex = colorIndex
        self.position = position
        self.status = status
        self.error = error
        self.worktreePath = worktreePath
        self.worktreeStatus = worktreeStatus
        self.headSha = headSha
        self.baseSha = baseSha
        self.mergeBaseSha = mergeBaseSha
        self.setupConsent = setupConsent
        self.setupHeadSha = setupHeadSha
        self.setupStatus = setupStatus
        self.setupLog = setupLog
        self.addedAt = addedAt
    }

    /// The PR's commits are fetched and its checkout is on disk.
    public var checkoutReady: Bool { status == "ready" && worktreeStatus == "ready" }

    /// What the review recorded as looked at when the user comments or reviews.
    public var seen: SeenCommits { SeenCommits(headSha: headSha, mergeBaseSha: mergeBaseSha) }
}

/// A review workspace. The list's rows carry PRs without their setup logs.
public struct ReviewWorkspace: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    /// "active", "archiving" or "archived".
    public var status: String
    /// What an archive left behind, if anything.
    public var error: String?
    public var createdAt: String
    public var updatedAt: String
    public var lastOpenedAt: String?
    /// Whether Ask Claude also loads the repos' own skills and CLAUDE.md.
    public var askClaudeRepoConfig: Bool
    public var prs: [ReviewWorkspacePr]

    public init(id: String, name: String, status: String = "active", error: String? = nil, createdAt: String = "",
                updatedAt: String = "", lastOpenedAt: String? = nil, askClaudeRepoConfig: Bool = false,
                prs: [ReviewWorkspacePr] = []) {
        self.id = id
        self.name = name
        self.status = status
        self.error = error
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastOpenedAt = lastOpenedAt
        self.askClaudeRepoConfig = askClaudeRepoConfig
        self.prs = prs
    }
}

/// A file the PR changes, between its merge-base and head.
public struct ReviewChangedFile: Codable, Sendable, Equatable, Hashable {
    public var path: String
    public var oldPath: String?
    /// "added", "modified", "deleted" or "renamed".
    public var status: String
    public var additions: Int
    public var deletions: Int
    public var binary: Bool

    public init(path: String, oldPath: String? = nil, status: String = "modified", additions: Int = 0,
                deletions: Int = 0, binary: Bool = false) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.additions = additions
        self.deletions = deletions
        self.binary = binary
    }
}

/// The commits a read answered from, so a cache keyed by them never goes stale.
public struct ReviewChangedFiles: Codable, Sendable, Equatable {
    public var headSha: String
    public var mergeBaseSha: String
    public var files: [ReviewChangedFile]
}

/// Every path in the tree at the PR's head.
public struct ReviewTree: Codable, Sendable, Equatable {
    public var headSha: String
    public var paths: [String]
}

public struct ReviewFileContent: Codable, Sendable, Equatable {
    public var content: String
    public var binary: Bool
    public var tooLarge: Bool
    public var size: Int
    /// The commit it was read from.
    public var sha: String
}

public enum ReviewFileSide: String, Sendable {
    case base, head
}

public struct ReviewFileDiff: Codable, Sendable, Equatable {
    public var headSha: String
    public var mergeBaseSha: String
    public var path: String
    public var oldPath: String?
    public var patch: String
    /// Either side is over the size cap, so `patch` is empty.
    public var tooLarge: Bool
}

/// One line a symbol search found at the PR's head; `line` and `column` are 1-based.
public struct ReviewSymbolMatch: Codable, Sendable, Equatable, Hashable {
    public var path: String
    public var line: Int
    public var column: Int
    public var preview: String
}

public struct ReviewSymbolSearch: Codable, Sendable, Equatable {
    public var headSha: String
    /// Best first: the asking file, its directory, what it imports, the rest.
    public var matches: [ReviewSymbolMatch]
    /// There were more, or the search ran out of time.
    public var truncated: Bool
}

public enum ReviewSymbolKind: String, Sendable {
    case definitions, references
}

/// What the setup prompt shows. `script` and `headSha` go back with the
/// answer, so a script or head that moved since is refused rather than run.
public struct ReviewSetupInfo: Codable, Sendable, Equatable {
    public var script: String?
    public var author: String?
    public var branch: String?
    public var headSha: String?
    /// Environment variables the script won't get, such as the SSH agent.
    public var withheldEnv: [String]
    public var sandboxNotes: String?
    public var consent: String?
    public var status: String?
    public var log: String?
}

/// One event of a PR's clone, refresh or setup run (`…/progress`).
public enum ReviewProgressEvent: Sendable, Equatable {
    /// `phase` is "clone", "refresh" or "setup".
    case start(phase: String)
    case log(String)
    case done(phase: String, status: String, error: String?)

    public static func decode(_ json: Data) throws -> ReviewProgressEvent {
        struct Raw: Decodable {
            var type: String
            var phase: String?
            var text: String?
            var status: String?
            var error: String?
        }
        let raw = try JSONDecoder().decode(Raw.self, from: json)
        switch raw.type {
        case "start": return .start(phase: raw.phase ?? "")
        case "log": return .log(raw.text ?? "")
        case "done": return .done(phase: raw.phase ?? "", status: raw.status ?? "", error: raw.error)
        default: throw YarvisError.badResponse
        }
    }
}

// MARK: Since last review

/// Where the user last reviewed. `source` is "review", "comment", "manual"
/// or "provider".
public struct ReviewMark: Codable, Sendable, Equatable {
    public var headSha: String
    public var baseSha: String?
    public var mergeBaseSha: String?
    public var source: String
    public var createdAt: String
}

/// `…/last-review`. `shaExists` is false when the reviewed commit can no
/// longer be fetched.
public struct LastReview: Codable, Sendable, Equatable {
    public var mark: ReviewMark?
    public var shaExists: Bool?
    public var headSha: String?
    public var upToDate: Bool
}

public struct ReviewCommit: Codable, Sendable, Equatable, Hashable {
    public var sha: String
    public var subject: String
    public var author: String
    public var date: String
    public var parents: [String]?
    /// New since the last review.
    public var isNew: Bool
    /// The reviewed commit this one is a rebase of.
    public var rebasedFrom: String?
}

public struct SinceFile: Codable, Sendable, Equatable, Hashable {
    public var path: String
    public var oldPath: String?
    /// "added", "modified" or "reverted".
    public var status: String
    public var additions: Int
    public var deletions: Int
    public var binary: Bool
    public var tooLarge: Bool
}

public struct SinceReview: Codable, Sendable, Equatable {
    public var fromHeadSha: String
    public var toHeadSha: String
    public var fromMergeBase: String?
    public var toMergeBase: String?
    public var rebased: Bool
    public var baseMoved: Bool
    public var mark: ReviewMark
    public var files: [SinceFile]
    public var filesTruncated: Bool
    public var commits: [ReviewCommit]
    public var removedCommits: [ReviewCommit]
    public var commitsTruncated: Bool
    public var rebaseMatchSkipped: Bool
}

/// One side of a two-file comparison.
public struct FileSide: Codable, Sendable, Equatable {
    public var content: String
    public var binary: Bool
    public var tooLarge: Bool
    public var size: Int
}

/// One file's change since the last review. `mode` is "direct", "carried"
/// or "upstream-included".
public struct SinceFileView: Codable, Sendable, Equatable {
    public var path: String
    public var oldPath: String?
    public var status: String
    public var mode: String
    public var fromHeadSha: String
    public var toHeadSha: String
    public var original: FileSide?
    public var modified: FileSide?
    public var patch: String
    public var additions: Int
    public var deletions: Int
    public var tooLarge: Bool
}

public struct PrCommits: Codable, Sendable, Equatable {
    public var headSha: String
    public var mergeBaseSha: String
    public var fromHeadSha: String?
    public var commits: [ReviewCommit]
    public var truncated: Bool
}

/// One commit against its first parent.
public struct CommitFiles: Codable, Sendable, Equatable {
    public var sha: String
    public var parentSha: String
    public var files: [ReviewChangedFile]
}

public struct CommitFileDiff: Codable, Sendable, Equatable {
    public var sha: String
    public var parentSha: String
    public var path: String
    public var oldPath: String?
    public var status: String
    public var original: FileSide?
    public var modified: FileSide?
    public var patch: String
    public var tooLarge: Bool
}

// MARK: Agent runs

/// One event of a headless Claude Code run (`/api/agent-runs/{id}/events`).
public enum AgentRunEvent: Sendable, Equatable {
    case status(String)
    case text(String, subagentId: String?)
    case tool(id: String, name: String, summary: String, subagentId: String?)
    /// `phase` is "start" or "stop".
    case subagent(phase: String, id: String, name: String, description: String, failed: Bool)
    case result(text: String, costUsd: Double?, durationMs: Double?)
    case error(String)
    /// `status` is "succeeded", "failed" or "cancelled".
    case done(status: String)

    public static func decode(_ json: Data) throws -> AgentRunEvent {
        let value = try JSONDecoder().decode(JSONValue.self, from: json)
        return try decode(value)
    }

    static func decode(_ v: JSONValue) throws -> AgentRunEvent {
        let s = { (key: String) in v[key]?.stringValue }
        switch s("type") {
        case "status": return .status(s("message") ?? "")
        case "text": return .text(s("text") ?? "", subagentId: s("subagentId"))
        case "tool":
            return .tool(id: s("id") ?? "", name: s("name") ?? "", summary: s("summary") ?? "",
                         subagentId: s("subagentId"))
        case "subagent":
            return .subagent(phase: s("phase") ?? "", id: s("id") ?? "", name: s("name") ?? "",
                             description: s("description") ?? "", failed: v["failed"]?.reviewBool ?? false)
        case "result":
            return .result(text: s("text") ?? "", costUsd: v["costUsd"]?.reviewNumber,
                           durationMs: v["durationMs"]?.reviewNumber)
        case "error": return .error(s("message") ?? "")
        case "done": return .done(status: s("status") ?? "")
        // `ping` keeps the connection open and carries nothing.
        default: throw YarvisError.badResponse
        }
    }
}

private extension JSONValue {
    var reviewBool: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    var reviewNumber: Double? {
        if case .number(let n) = self { return n }
        return nil
    }
}

// MARK: Re-review summary

public struct RereviewComment: Codable, Sendable, Equatable, Hashable {
    public struct Evidence: Codable, Sendable, Equatable, Hashable {
        public var path: String?
        public var line: Int?
        public var note: String
    }

    public var threadId: String
    /// "thread" or "conversation".
    public var kind: String
    public var providerId: String
    public var path: String?
    public var line: Int?
    public var resolved: Bool
    /// "addressed", "partly", "not_addressed", "disagreed" or "unclear".
    public var verdict: String
    public var evidence: Evidence
    public var replySummary: String?
    public var downgradedFrom: String?
}

public struct LineRange: Codable, Sendable, Equatable, Hashable {
    public var start: Int
    public var end: Int

    public init(start: Int, end: Int) {
        self.start = start
        self.end = end
    }
}

public struct RereviewChange: Codable, Sendable, Equatable, Hashable {
    public var path: String
    public var lines: LineRange?
    /// "needs_review" or "minor".
    public var kind: String
    public var reason: String
}

public struct Rereview: Codable, Sendable, Equatable {
    public struct Settled: Codable, Sendable, Equatable, Hashable {
        public var providerId: String
        public var path: String?
        public var line: Int?
    }

    public var summary: String
    /// "ready_to_approve" or "needs_another_look".
    public var verdict: String
    public var verdictReason: String
    public var serverNote: String?
    public var comments: [RereviewComment]
    public var newChanges: [RereviewChange]
    public var settled: [Settled]?
    public var coverage: ReportCoverage?
}

public struct RereviewSize: Codable, Sendable, Equatable {
    public var files: Int
    public var changedLines: Int?
    public var binary: [String]
    public var noInterdiff: [String]
    public var skimmed: [String]
    public var readBytes: Int
    public var overAgentBudget: Bool
    public var estimatedCostUsd: Double
    public var budgetUsd: Double
    public var overBudget: Bool
}

public struct RereviewRun: Codable, Sendable, Equatable {
    public var id: String
    /// "running", "succeeded", "failed" or "cancelled".
    public var status: String
    public var result: Rereview?
    public var error: String?
    public var costUsd: Double?
    public var startedAt: String
    public var finishedAt: String?
    public var fromHeadSha: String?
    public var toHeadSha: String?
    /// Only on `LatestRereview.run`: this sidecar is running it, so it can be followed.
    public var live: Bool?
}

public struct LatestRereview: Codable, Sendable, Equatable {
    public struct Succeeded: Codable, Sendable, Equatable {
        public var run: RereviewRun
        public var fromHeadSha: String?
        public var toHeadSha: String?
        public var current: Bool
    }

    public var run: RereviewRun?
    public var fromHeadSha: String?
    public var headSha: String?
    public var current: Bool
    public var lastSucceeded: Succeeded?
    public var size: RereviewSize?
}

public struct StartedRereview: Codable, Sendable, Equatable {
    public var runId: String
    public var existing: Bool
    public var fromHeadSha: String
    public var toHeadSha: String
}

/// `GET /api/pr-models/rereview`; the tab reads only `autoStart`.
public struct RereviewRunConfig: Codable, Sendable, Equatable {
    public var model: String
    public var maxBudgetUsd: Double
    public var autoStart: Bool
}

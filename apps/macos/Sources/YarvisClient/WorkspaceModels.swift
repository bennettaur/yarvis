import Foundation

// The Workspaces page's JSON shapes, from the sidecar's `workspaces/routes.ts`
// and the web client's `src/lib/workspaces.ts`. Provider-reported values
// (PR state, mergeable, check rollups) stay free-form strings, since a
// provider can report a value this build has never seen.

/// A registered repository (`GET /api/repos`).
public struct Repo: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: String
    public var name: String
    public var owner: String
    public var repo: String
    public var cloneUrl: String
    public var defaultBranch: String?
    public var setupScript: String?
    public var runScript: String?
    public var pullIssues: Bool?

    /// `owner/repo`, as the repo checklist shows it.
    public var fullName: String { "\(owner)/\(repo)" }
}

public struct PrCheckCounts: Codable, Sendable, Equatable, Hashable {
    public var total: Int
    public var success: Int
    public var failure: Int
    public var pending: Int
}

/// A PR linked to one of a workspace's repos, as the sidecar's poller last saw it.
public struct WorkspaceRepoPr: Codable, Sendable, Equatable, Hashable {
    public var prNumber: Int?
    public var prUrl: String?
    public var prState: String?
    /// Set when the PR is on another branch than the workspace's, such as a stack layer.
    public var headBranch: String?
    public var isDraft: Bool?
    public var mergeable: String?
    public var checkRollup: String?
    public var checks: PrCheckCounts?
    public var reviewDecision: String?
    public var lastPolledAt: String?
    public var lastError: String?

    public init(prNumber: Int?, prUrl: String? = nil, prState: String? = nil, headBranch: String? = nil,
                isDraft: Bool? = nil, mergeable: String? = nil, checkRollup: String? = nil,
                checks: PrCheckCounts? = nil, reviewDecision: String? = nil,
                lastPolledAt: String? = nil, lastError: String? = nil) {
        self.prNumber = prNumber
        self.prUrl = prUrl
        self.prState = prState
        self.headBranch = headBranch
        self.isDraft = isDraft
        self.mergeable = mergeable
        self.checkRollup = checkRollup
        self.checks = checks
        self.reviewDecision = reviewDecision
        self.lastPolledAt = lastPolledAt
        self.lastError = lastError
    }
}

/// One repo of a workspace: its worktree, branch and PRs.
public struct WorkspaceRepoDetail: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: String
    public var workspaceId: String
    public var repoId: String
    /// `pending`, `provisioning`, `ready`, `removed` or `error`.
    public var status: String
    public var branch: String
    public var existingBranch: Bool?
    public var baseBranch: String?
    public var worktreePath: String
    public var setupLog: String?
    public var setupExitCode: Int?
    public var error: String?
    public var repo: Repo
    /// The main PR, which the PR checks view reads.
    public var pr: WorkspaceRepoPr?
    public var prs: [WorkspaceRepoPr]?
    public var prsPolledAt: String?
    public var prsPollError: String?
}

/// One of the user's tasks (`/api/tasks`).
public struct WorkspaceTask: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: String
    public var title: String
    /// `open` or `done`.
    public var status: String
    /// `daily` or `weekly`.
    public var scope: String?
}

/// A tracker issue linked to a workspace.
public struct IssueLink: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: String
    /// `github`, `jira` or `azure`.
    public var provider: String
    public var sourceKey: String
    public var externalId: String
    public var title: String?
    public var url: String?
    /// `todo`, `in_progress` or `done`.
    public var localStatus: String?
}

/// `GET /api/workspaces/{id}`.
public struct WorkspaceDetail: Codable, Sendable, Identifiable, Equatable {
    public var id: String
    public var name: String
    public var slug: String?
    /// `creating`, `active`, `archiving`, `archived` or `error`.
    public var status: String
    public var rootPath: String
    public var summary: String?
    public var mergedPrUrl: String?
    public var error: String?
    public var archivedAt: String?
    public var repos: [WorkspaceRepoDetail]
    public var tasks: [WorkspaceTask]
    public var issues: [IssueLink]

    public init(id: String, name: String, slug: String? = nil, status: String, rootPath: String,
                summary: String? = nil, mergedPrUrl: String? = nil, error: String? = nil,
                archivedAt: String? = nil, repos: [WorkspaceRepoDetail] = [], tasks: [WorkspaceTask] = [],
                issues: [IssueLink] = []) {
        self.id = id
        self.name = name
        self.slug = slug
        self.status = status
        self.rootPath = rootPath
        self.summary = summary
        self.mergedPrUrl = mergedPrUrl
        self.error = error
        self.archivedAt = archivedAt
        self.repos = repos
        self.tasks = tasks
        self.issues = issues
    }

    // The arrays are read leniently so a sidecar that leaves one out still loads.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        slug = try c.decodeIfPresent(String.self, forKey: .slug)
        status = try c.decode(String.self, forKey: .status)
        rootPath = try c.decode(String.self, forKey: .rootPath)
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        mergedPrUrl = try c.decodeIfPresent(String.self, forKey: .mergedPrUrl)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        archivedAt = try c.decodeIfPresent(String.self, forKey: .archivedAt)
        repos = try c.decodeIfPresent([WorkspaceRepoDetail].self, forKey: .repos) ?? []
        tasks = try c.decodeIfPresent([WorkspaceTask].self, forKey: .tasks) ?? []
        issues = try c.decodeIfPresent([IssueLink].self, forKey: .issues) ?? []
    }

    /// The same workspace as the list carries it, for calls that take one.
    public var summaryRow: WorkspaceSummary {
        WorkspaceSummary(id: id, name: name, status: status, rootPath: rootPath,
                         repoNames: repos.map(\.repo.name))
    }
}

/// One file that differs from the workspace's base branch.
public struct ChangedFile: Codable, Sendable, Equatable, Hashable {
    public var path: String
    /// `added`, `modified`, `deleted`, `renamed` or `untracked`.
    public var status: String
    public var additions: Int
    public var deletions: Int

    public init(path: String, status: String, additions: Int = 0, deletions: Int = 0) {
        self.path = path
        self.status = status
        self.additions = additions
        self.deletions = deletions
    }
}

public struct FileDiff: Codable, Sendable, Equatable {
    public var path: String
    /// A unified diff; empty for a binary or unchanged file.
    public var patch: String
}

/// A note the user (or a verification run) left on lines of a changed file.
public struct ReviewComment: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: String
    public var workspaceRepoId: String
    public var path: String
    /// 1-based lines of the new file.
    public var startLine: Int
    public var endLine: Int
    public var commitSha: String?
    public var body: String
    /// `user` or `verification`.
    public var source: String?
    public var resolvedAt: String?
    public var createdAt: String

    public var isResolved: Bool { resolvedAt != nil }

    public init(id: String, workspaceRepoId: String, path: String, startLine: Int, endLine: Int,
                commitSha: String? = nil, body: String, source: String? = "user", resolvedAt: String? = nil,
                createdAt: String = "") {
        self.id = id
        self.workspaceRepoId = workspaceRepoId
        self.path = path
        self.startLine = startLine
        self.endLine = endLine
        self.commitSha = commitSha
        self.body = body
        self.source = source
        self.resolvedAt = resolvedAt
        self.createdAt = createdAt
    }
}

/// How a workspace repo's branch stands against its remote and its base.
public struct SyncStatus: Codable, Sendable, Equatable {
    public var ahead: Int
    public var behind: Int
    public var baseBehind: Int
    public var hasRemote: Bool
    public var fetchError: String?

    public init(ahead: Int, behind: Int, baseBehind: Int, hasRemote: Bool, fetchError: String? = nil) {
        self.ahead = ahead
        self.behind = behind
        self.baseBehind = baseBehind
        self.hasRemote = hasRemote
        self.fetchError = fetchError
    }
}

/// The other worktrees of one workspace repo's clone.
public struct WorktreeListing: Codable, Sendable, Equatable {
    public struct Worktree: Codable, Sendable, Equatable, Hashable {
        public var path: String
        public var branch: String?
        public var primary: Bool

        public init(path: String, branch: String?, primary: Bool) {
            self.path = path
            self.branch = branch
            self.primary = primary
        }
    }
    public var workspaceRepoId: String
    public var worktrees: [Worktree]
    public var error: String?
}

/// A file read for the editor.
public struct WorkspaceFile: Codable, Sendable, Equatable {
    public var path: String
    public var content: String?
    /// `binary`, `too-large`, `encoding`, or nil when it can be edited.
    public var unreadable: String?
    /// What a save must send back, so it can't overwrite a change made since.
    public var hash: String?
    public var size: Int
}

/// An agent program the user configured (`get_agent_config`).
public struct AgentHarness: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: String
    public var name: String
    public var kind: String?
}

public struct AgentConfig: Codable, Sendable, Equatable {
    public var name: String
    public var harnesses: [AgentHarness]
    public var defaultHarness: String?

    public init(name: String, harnesses: [AgentHarness] = [], defaultHarness: String? = nil) {
        self.name = name
        self.harnesses = harnesses
        self.defaultHarness = defaultHarness
    }

    /// What the page uses when the config can't be read.
    public static let fallback = AgentConfig(name: "Claude")

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Claude"
        harnesses = try c.decodeIfPresent([AgentHarness].self, forKey: .harnesses) ?? []
        defaultHarness = try c.decodeIfPresent(String.self, forKey: .defaultHarness)
    }
}

/// What `prs/detect` found per workspace repo. No repos at all means no
/// GitHub or Azure DevOps token could read them.
public struct DetectedPrs: Codable, Sendable, Equatable {
    public struct RepoPrs: Codable, Sendable, Equatable {
        public struct Found: Codable, Sendable, Equatable {
            public var number: Int
            public var url: String?
            public var branch: String?
        }
        public var workspaceRepoId: String
        public var prs: [Found]
    }
    public var repos: [RepoPrs]
}

/// What the archive dialog sends.
public struct ArchiveRequest: Sendable, Equatable {
    public var summary: String?
    public var mergedPrUrl: String?
    public var force: Bool
    public var closeIssueIds: [String]

    public init(summary: String?, mergedPrUrl: String?, force: Bool, closeIssueIds: [String]) {
        self.summary = summary
        self.mergedPrUrl = mergedPrUrl
        self.force = force
        self.closeIssueIds = closeIssueIds
    }
}

/// What the new-workspace form sends.
public struct NewWorkspace: Sendable, Equatable {
    public var name: String
    public var repoIds: [String]
    /// An existing remote branch per repo id; a repo left out gets a new branch.
    public var existingBranches: [String: String]
    public var taskId: String?
    public var startWork: Bool?

    public init(name: String, repoIds: [String], existingBranches: [String: String] = [:],
                taskId: String? = nil, startWork: Bool? = nil) {
        self.name = name
        self.repoIds = repoIds
        self.existingBranches = existingBranches
        self.taskId = taskId
        self.startWork = startWork
    }
}

/// One message on the provision stream.
public enum ProvisionEvent: Sendable, Equatable {
    case repoStart(workspaceRepoId: String, repo: String)
    case log(workspaceRepoId: String, text: String)
    case repoDone(workspaceRepoId: String, status: String)
    case repoError(workspaceRepoId: String, message: String)
    /// Ends the run.
    case done(status: String)
    /// Ends the run with a failure of the whole provision.
    case error(String)
    case unknown

    public static func decode(_ json: Data) throws -> ProvisionEvent {
        let v = try JSONDecoder().decode(JSONValue.self, from: json)
        func s(_ k: String) -> String { v[k]?.stringValue ?? "" }
        switch v["type"]?.stringValue {
        case "repo-start": return .repoStart(workspaceRepoId: s("workspaceRepoId"), repo: s("repo"))
        case "log": return .log(workspaceRepoId: s("workspaceRepoId"), text: s("text"))
        case "repo-done": return .repoDone(workspaceRepoId: s("workspaceRepoId"), status: s("status"))
        case "repo-error": return .repoError(workspaceRepoId: s("workspaceRepoId"), message: s("message"))
        case "done": return .done(status: s("status"))
        case "error": return .error(s("message"))
        default: return .unknown
        }
    }
}

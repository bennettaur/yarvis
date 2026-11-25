import Foundation

// Provider-neutral pull-request shapes, from the web's `src/lib/pr/types.ts`
// and the sidecar's GitHub and Azure DevOps routes. Provider-reported values
// (state, mergeable, check status) stay free-form strings, since a provider
// can report a value this build has never seen.

/// A pull request's identity. The Azure org is implicit (server config) in
/// the sidecar's routes, but travels in the ref.
public enum PrRef: Sendable, Equatable, Hashable {
    case github(owner: String, repo: String, number: Int)
    case azure(org: String, project: String, repo: String, prId: Int)

    public var provider: String {
        switch self {
        case .github: return "github"
        case .azure: return "azure"
        }
    }

    /// The PR's number as the provider shows it.
    public var number: Int {
        switch self {
        case .github(_, _, let n): return n
        case .azure(_, _, _, let id): return id
        }
    }

    /// `owner/repo` on GitHub, `project/repo` on Azure.
    public var displayRepo: String {
        switch self {
        case .github(let owner, let repo, _): return "\(owner)/\(repo)"
        case .azure(_, let project, let repo, _): return "\(project)/\(repo)"
        }
    }

    public var repoName: String {
        switch self {
        case .github(_, let repo, _), .azure(_, _, let repo, _): return repo
        }
    }

    /// The identity the sidecar stores and compares (`ReviewWorkspacePr.refKey`).
    public var key: String {
        switch self {
        case .github(let owner, let repo, let n): return "gh:\(owner)/\(repo)/\(n)"
        case .azure(let org, let project, let repo, let id): return "az:\(org)/\(project)/\(repo)/\(id)"
        }
    }

    /// "GitHub" or "Azure DevOps", for "Open on …".
    public var providerName: String {
        switch self {
        case .github: return "GitHub"
        case .azure: return "Azure DevOps"
        }
    }

    /// The PR's page on its provider, for when only the ref is known.
    public var webURL: URL? {
        switch self {
        case .github(let owner, let repo, let n):
            return URL(string: "https://github.com/\(encodePathSegment(owner))/\(encodePathSegment(repo))/pull/\(n)")
        case .azure(let org, let project, let repo, let id):
            return URL(string: "https://dev.azure.com/\(encodePathSegment(org))/\(encodePathSegment(project))"
                + "/_git/\(encodePathSegment(repo))/pullrequest/\(id)")
        }
    }

    /// The ref as the sidecar takes it in a request body.
    public var json: JSONValue {
        switch self {
        case .github(let owner, let repo, let n):
            return .object(["provider": .string("github"), "owner": .string(owner), "repo": .string(repo),
                            "number": .number(Double(n))])
        case .azure(let org, let project, let repo, let id):
            return .object(["provider": .string("azure"), "org": .string(org), "project": .string(project),
                            "repo": .string(repo), "prId": .number(Double(id))])
        }
    }

    /// The ref as query items, for the provider-neutral `/api/pr/*` routes.
    var queryItems: [(String, String)] {
        switch self {
        case .github(let owner, let repo, let n):
            return [("provider", "github"), ("owner", owner), ("repo", repo), ("number", String(n))]
        case .azure(let org, let project, let repo, let id):
            return [("provider", "azure"), ("org", org), ("project", project), ("repo", repo), ("prId", String(id))]
        }
    }
}

extension PrRef: Codable {
    private enum CodingKeys: String, CodingKey { case provider, owner, repo, number, org, project, prId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .provider) {
        case "github":
            self = .github(owner: try c.decode(String.self, forKey: .owner),
                           repo: try c.decode(String.self, forKey: .repo),
                           number: try c.decode(Int.self, forKey: .number))
        case "azure":
            self = .azure(org: try c.decode(String.self, forKey: .org),
                          project: try c.decode(String.self, forKey: .project),
                          repo: try c.decode(String.self, forKey: .repo),
                          prId: try c.decode(Int.self, forKey: .prId))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .provider, in: c,
                                                   debugDescription: "unknown provider \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(provider, forKey: .provider)
        switch self {
        case .github(let owner, let repo, let n):
            try c.encode(owner, forKey: .owner)
            try c.encode(repo, forKey: .repo)
            try c.encode(n, forKey: .number)
        case .azure(let org, let project, let repo, let id):
            try c.encode(org, forKey: .org)
            try c.encode(project, forKey: .project)
            try c.encode(repo, forKey: .repo)
            try c.encode(id, forKey: .prId)
        }
    }
}

/// A full 40- or 64-hex commit id. Only these are sent as "what the page
/// showed", so a short or empty sha never moves the user's review mark.
public func isFullSha(_ s: String?) -> Bool {
    guard let s, s.count == 40 || s.count == 64 else { return false }
    return s.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
}

/// The commits the page showed when the user commented or reviewed. The
/// sidecar records the review there, which is where "Since last review" starts.
public struct SeenCommits: Sendable, Equatable {
    public var headSha: String?
    public var baseSha: String?
    public var mergeBaseSha: String?

    public init(headSha: String? = nil, baseSha: String? = nil, mergeBaseSha: String? = nil) {
        self.headSha = headSha
        self.baseSha = baseSha
        self.mergeBaseSha = mergeBaseSha
    }

    /// The request fields, leaving out anything that isn't a full sha.
    public var fields: [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        if isFullSha(headSha), let headSha { out["headSha"] = .string(headSha) }
        if isFullSha(baseSha), let baseSha { out["baseSha"] = .string(baseSha) }
        if isFullSha(mergeBaseSha), let mergeBaseSha { out["mergeBaseSha"] = .string(mergeBaseSha) }
        return out
    }
}

public struct PrSummary: Codable, Sendable, Equatable, Hashable {
    public var ref: PrRef
    public var title: String
    public var url: String
    public var author: String
    public var draft: Bool
    public var state: String
    public var createdAt: String
    public var updatedAt: String
    public var baseRef: String?
    public var headRef: String?

    public init(ref: PrRef, title: String, url: String, author: String, draft: Bool, state: String,
                createdAt: String, updatedAt: String, baseRef: String? = nil, headRef: String? = nil) {
        self.ref = ref
        self.title = title
        self.url = url
        self.author = author
        self.draft = draft
        self.state = state
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.baseRef = baseRef
        self.headRef = headRef
    }
}

/// `GET {PR}`: the cheap read a poll uses to notice a push.
public struct PrStatus: Codable, Sendable, Equatable {
    public var mergeable: Bool?
    public var mergeableState: String?
    public var headSha: String?
    public var checks: PrCheckCounts
}

/// Which file of a diff a line belongs to: the base (`LEFT`) or the head (`RIGHT`).
public enum DiffSide: String, Codable, Sendable, Hashable {
    case left = "LEFT"
    case right = "RIGHT"
}

/// One comment in a provider review thread. `id` is a GraphQL node id on
/// GitHub, the comment's number within its thread on Azure.
public struct PrComment: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var author: String
    public var body: String
    public var createdAt: String
    public var url: String?

    public init(id: String, author: String, body: String, createdAt: String, url: String? = nil) {
        self.id = id
        self.author = author
        self.body = body
        self.createdAt = createdAt
        self.url = url
    }
}

/// A provider review thread. `line` is the last line of the range on `side`;
/// a range also has `startLine` on `startSide`. A thread the provider can no
/// longer place on the diff has a nil `line`.
public struct PrThread: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var path: String?
    public var line: Int?
    public var startLine: Int?
    public var startSide: DiffSide?
    public var side: DiffSide
    public var isResolved: Bool
    public var isOutdated: Bool
    public var canReply: Bool
    public var canResolve: Bool
    public var canUnresolve: Bool
    public var comments: [PrComment]

    public init(id: String, path: String?, line: Int?, startLine: Int? = nil, startSide: DiffSide? = nil,
                side: DiffSide = .right, isResolved: Bool = false, isOutdated: Bool = false, canReply: Bool = true,
                canResolve: Bool = true, canUnresolve: Bool = true, comments: [PrComment]) {
        self.id = id
        self.path = path
        self.line = line
        self.startLine = startLine
        self.startSide = startSide
        self.side = side
        self.isResolved = isResolved
        self.isOutdated = isOutdated
        self.canReply = canReply
        self.canResolve = canResolve
        self.canUnresolve = canUnresolve
        self.comments = comments
    }
}

public struct PrCheck: Codable, Sendable, Equatable, Hashable {
    public var name: String
    public var status: String
    public var conclusion: String?
    public var url: String?
}

/// `pending` covers both "requested, not yet reviewed" and a reset vote;
/// `isRequested` tells an outstanding request from a dismissed review.
public enum ReviewerState: String, Codable, Sendable, Hashable {
    case approved
    case changesRequested = "changes_requested"
    case commented, pending, dismissed
}

public struct PrReviewer: Codable, Sendable, Equatable, Hashable {
    public var login: String
    public var state: ReviewerState
    public var isRequested: Bool
}

/// A merge strategy the repo allows, in GitHub's GraphQL vocabulary.
public enum MergeMethod: String, Codable, Sendable, Hashable, CaseIterable {
    case merge = "MERGE"
    case squash = "SQUASH"
    case rebase = "REBASE"
}

/// `GET {PR}/detail`.
public struct PrDetail: Codable, Sendable, Equatable {
    public var number: Int
    public var title: String
    public var body: String
    public var state: String
    public var draft: Bool
    public var author: String
    public var baseRef: String
    public var headRef: String
    public var fromFork: Bool
    /// Empty when the provider hasn't reported one yet.
    public var headSha: String
    public var additions: Int
    public var deletions: Int
    public var mergeable: String
    public var hasConflicts: Bool
    /// Empty on Azure, which hides the merge buttons.
    public var mergeMethods: [MergeMethod]
    public var autoMergeEnabled: Bool
    public var canEnableAutoMerge: Bool
    public var canDisableAutoMerge: Bool
    public var checks: [PrCheck]
    public var checksUnavailable: Bool?
    public var reviewThreads: [PrThread]
    public var reviewThreadsTruncated: Bool?
    /// Comments on the PR itself; GitHub only.
    public var conversation: [PrComment]?
    public var conversationTruncated: Bool?
    public var reviewers: [PrReviewer]
    /// Absent when the provider couldn't say who the viewer is.
    public var viewerReview: ReviewerState?
}

/// Where a posted comment landed: on its lines, or on the whole file when
/// GitHub refused lines outside the diff.
public enum CommentPlacement: String, Codable, Sendable, Hashable {
    case line, file
}

public struct PostedComment: Codable, Sendable, Equatable {
    public var ok: Bool
    public var placement: CommentPlacement?
}

/// A line comment to post. `line` is always the last line; a range names
/// its first in `startLine`, on the same side.
public struct NewPrComment: Sendable, Equatable {
    public var path: String
    public var line: Int
    public var body: String
    public var side: DiffSide
    public var startLine: Int?

    public init(path: String, line: Int, body: String, side: DiffSide = .right, startLine: Int? = nil) {
        self.path = path
        self.line = line
        self.body = body
        self.side = side
        self.startLine = startLine
    }
}

/// A provider-neutral review verdict. `publish` lifts a draft to ready.
public enum PrReviewAction: String, Sendable, Hashable {
    case publish, approve
    case requestChanges = "request_changes"
}

/// One layer of a stack. `number` is 0 for a branch `gh stack` tracks that
/// has no PR yet.
public struct StackEntry: Codable, Sendable, Equatable, Hashable {
    public var ref: PrRef
    public var number: Int
    public var title: String
    public var url: String
    public var baseRef: String
    public var headRef: String
    /// "open", "closed", "merged", or "none" for a branch with no PR.
    public var state: String
    public var merged: Bool
    public var draft: Bool
    public var queued: Bool
    public var checks: PrCheckCounts
    /// "approved", "changes_requested", "review_required" or nil.
    public var reviewDecision: String?
    public var isCurrent: Bool?
    public var needsUpdate: Bool?
    /// False when the provider couldn't be reached for this layer.
    public var statusKnown: Bool?

    public var hasPullRequest: Bool { number != 0 }
}

/// A PR's stack, bottom (closest to the trunk) first.
public struct PrStack: Codable, Sendable, Equatable {
    public var trunk: String
    public var entries: [StackEntry]
    public var stackNumber: Int?
    public var truncated: Bool
}

/// What a hand-off to a workspace agent did (`/api/pr/resolve-conflicts`).
/// `needsConfirm` carries the reason to show before sending anyway.
public struct AgentHandOff: Codable, Sendable, Equatable {
    /// "sent", "started", "created" or "needs_confirm".
    public var outcome: String
    public var workspaceId: String
    public var name: String
    public var reason: String?

    public var needsConfirm: Bool { outcome == "needs_confirm" }
}

/// `POST /api/pr/workspace`.
public struct PrWorkspaceStart: Codable, Sendable, Equatable {
    public var workspaceId: String
    public var name: String
    /// True when the PR already had a workspace and it was reused.
    public var existing: Bool
}

/// `GET /api/workspaces/for-pr`: the workspace already on this PR's branch.
public struct WorkspaceForPr: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var slug: String
    public var status: String
    public var workspaceRepoId: String
}

// MARK: Guided review

public struct PrGuideFinding: Codable, Sendable, Equatable, Hashable {
    /// "error-handling", "stale-comment", "test-gap", "brittle-test",
    /// "naming", "convention" or "other".
    public var kind: String
    public var path: String
    /// Nil when it is about the file as a whole.
    public var startLine: Int?
    public var note: String
}

public struct PrGuideStep: Codable, Sendable, Equatable, Hashable {
    public var path: String
    public var startLine: Int?
    public var endLine: Int?
    public var explanation: String
    public var context: String?
    /// "walkthrough", "data" or "tests"; absent reads as a walkthrough.
    public var kind: String?
    public var covers: [String]?
    public var findings: [PrGuideFinding]?

    /// Every file the step accounts for, its own first, each once.
    public var paths: [String] {
        var seen = Set<String>()
        return ([path] + (covers ?? [])).filter { seen.insert($0).inserted }
    }
}

/// A piece of code the guide agent recorded while exploring the change.
public struct PrGraphNode: Codable, Sendable, Equatable, Hashable {
    public var id: String
    public var kind: String
    public var file: String?
    public var line: Int?
    public var endLine: Int?
    public var summary: String?
    public var changed: Bool?
}

public struct PrGraphEdge: Codable, Sendable, Equatable, Hashable {
    public var from: String
    public var to: String
    public var kind: String
}

public struct PrGuideGraph: Codable, Sendable, Equatable {
    public var nodes: [PrGraphNode]
    public var edges: [PrGraphEdge]
}

public struct PrGuide: Codable, Sendable, Equatable {
    public var headSha: String
    public var steps: [PrGuideStep]
    public var graph: PrGuideGraph?
    public var currentStep: Int
    /// True once the PR has moved past `headSha`.
    public var stale: Bool
    public var createdAt: String
}

// MARK: Insights

/// An answer to "ask about these lines".
public struct PrInsight: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var path: String
    public var startLine: Int
    public var endLine: Int
    /// The commit the answer was written against.
    public var headSha: String
    public var question: String
    public var answer: String
    public var postedAt: String?
    public var createdAt: String
    /// Only on the answer to a post, and not stored.
    public var placement: CommentPlacement?
}

public struct AskAboutLines: Sendable, Equatable {
    public var path: String
    public var startLine: Int
    public var endLine: Int
    /// The selected lines as shown, so the agent sees what the reader sees.
    public var selection: String
    public var question: String

    public init(path: String, startLine: Int, endLine: Int, selection: String, question: String) {
        self.path = path
        self.startLine = startLine
        self.endLine = endLine
        self.selection = selection
        self.question = question
    }
}

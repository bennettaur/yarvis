import Foundation

/// A tab in a review workspace. The static kinds are one per PR (Ask Claude
/// is one per workspace); the rest open per file or commit. Tab ids and the
/// saved shape match the web's `review/tabs/types.ts`, minus the reveal
/// line, which is never saved.
public struct ReviewTabSpec: Codable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Codable, Sendable, CaseIterable {
        case description, reviewers, checks, comments
        case sinceReview = "since-review"
        case guide, story, verification, diagram, mutation, claude
        case diff, file
        case sinceFile = "since-file"
        case commit

        /// Static tabs sit at the left of each strip in this order.
        public static let staticOrder: [Kind] = [
            .description, .reviewers, .checks, .comments, .sinceReview, .guide, .story, .verification,
            .diagram, .mutation, .claude,
        ]

        public var isStatic: Bool { ![.diff, .file, .sinceFile, .commit].contains(self) }

        public var label: String {
            switch self {
            case .description: return "Description"
            case .reviewers: return "Reviewers"
            case .checks: return "Checks"
            case .comments: return "Comments"
            case .sinceReview: return "Since last review"
            case .guide: return "Guided review"
            case .story: return "Story"
            case .verification: return "Verification"
            case .diagram: return "Flow diagram"
            case .mutation: return "Mutation testing"
            case .claude: return "Ask Claude"
            case .diff: return "Diff"
            case .file: return "File"
            case .sinceFile: return "Since review"
            case .commit: return "Commit"
            }
        }
    }

    public var kind: Kind
    public var prId: String
    /// diff, file and since-file.
    public var path: String?
    /// since-file: the head the user reviewed.
    public var from: String?
    /// commit.
    public var sha: String?
    public var subject: String?
    /// diff and file: the line to bring into view. Reopening the tab with a
    /// line bumps `revealNonce`, so the same line scrolls into view again.
    public var revealLine: Int?
    public var revealNonce: Int?

    private enum CodingKeys: String, CodingKey { case kind, prId, path, from, sha, subject }

    public init(kind: Kind, prId: String, path: String? = nil, from: String? = nil, sha: String? = nil,
                subject: String? = nil, revealLine: Int? = nil, revealNonce: Int? = nil) {
        self.kind = kind
        self.prId = prId
        self.path = path
        self.from = from
        self.sha = sha
        self.subject = subject
        self.revealLine = revealLine
        self.revealNonce = revealNonce
    }

    public static func diff(prId: String, path: String, revealLine: Int? = nil) -> ReviewTabSpec {
        ReviewTabSpec(kind: .diff, prId: prId, path: path, revealLine: revealLine)
    }

    public static func file(prId: String, path: String, revealLine: Int? = nil) -> ReviewTabSpec {
        ReviewTabSpec(kind: .file, prId: prId, path: path, revealLine: revealLine)
    }

    public static func sinceFile(prId: String, path: String, from: String) -> ReviewTabSpec {
        ReviewTabSpec(kind: .sinceFile, prId: prId, path: path, from: from)
    }

    public static func commit(prId: String, sha: String, subject: String? = nil) -> ReviewTabSpec {
        ReviewTabSpec(kind: .commit, prId: prId, sha: sha, subject: subject)
    }

    /// The tab's identity: a spec is open at most once across both groups.
    public var id: String {
        if kind == .claude { return "claude" }
        var id = "\(kind.rawValue):\(prId)"
        if let path { id += ":\(path)" } else if let sha { id += ":\(sha)" }
        return id
    }

    public var title: String {
        switch kind {
        case .diff, .file, .sinceFile:
            return (path ?? "").split(separator: "/").last.map(String.init) ?? kind.label
        case .commit:
            let short = String((sha ?? "").prefix(7))
            return subject.map { "\(short) \($0)" } ?? short
        default:
            return kind.label
        }
    }

    public var tooltip: String {
        switch kind {
        case .diff, .file: return path ?? title
        case .sinceFile: return "\(path ?? "") — since your review at \(String((from ?? "").prefix(7)))"
        case .commit: return subject.map { "\(sha ?? "") — \($0)" } ?? (sha ?? "")
        default: return title
        }
    }
}

/// A request to show a review workspace, with one of its PRs brought
/// forward: its description, or `tab` when given.
public struct OpenReviewRequest: Sendable, Equatable {
    public var workspaceId: String
    public var prId: String?
    /// `.sinceReview` or `.verification`.
    public var tab: ReviewTabSpec.Kind?

    public init(workspaceId: String, prId: String? = nil, tab: ReviewTabSpec.Kind? = nil) {
        self.workspaceId = workspaceId
        self.prId = prId
        self.tab = tab
    }
}

/// The active workspace already reviewing `ref`, most recently opened first,
/// so opening a PR twice lands on the same tabs instead of a second checkout.
public func findReviewWorkspace(holding ref: PrRef,
                                in workspaces: [ReviewWorkspace]) -> (workspaceId: String, prId: String)? {
    let opened = { (w: ReviewWorkspace) in w.lastOpenedAt ?? w.createdAt }
    let candidates = workspaces.filter { $0.status == "active" }.sorted { opened($0) > opened($1) }
    for w in candidates {
        if let pr = w.prs.first(where: { $0.refKey == ref.key }) { return (w.id, pr.id) }
    }
    return nil
}

/// "repo#12", the name a new workspace gets when its PR's title isn't known.
public func shortPrName(_ ref: PrRef) -> String { "\(ref.repoName)#\(ref.number)" }

// MARK: File order

/// The changed files in the order the nav's tree lists them: folders first,
/// then by name, at each level.
public func changedFileOrder(_ files: [ReviewChangedFile]) -> [String] {
    func flatten(_ nodes: [FileTreeNode]) -> [String] {
        nodes.flatMap { $0.children.map(flatten) ?? [$0.path] }
    }
    return flatten(buildFileTree(files.map(\.path)))
}

/// The first file after `path`, wrapping round, that isn't viewed yet.
public func nextUnviewed(order: [String], after path: String, viewed: Set<String>) -> String? {
    guard !order.isEmpty else { return nil }
    let at = order.firstIndex(of: path) ?? -1
    for step in 1...order.count {
        let candidate = order[(at + step + order.count) % order.count]
        if candidate != path && !viewed.contains(candidate) { return candidate }
    }
    return nil
}

/// The next or previous file for Option-J and Option-K, wrapping round. With
/// no current file, forward starts at the first and back at the last.
public func adjacentPath(_ paths: [String], current: String?, forward: Bool) -> String? {
    guard !paths.isEmpty else { return nil }
    guard let current, let index = paths.firstIndex(of: current) else {
        return forward ? paths.first : paths.last
    }
    return paths[(index + (forward ? 1 : -1) + paths.count) % paths.count]
}

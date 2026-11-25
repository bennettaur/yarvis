import Foundation

// MARK: Finding a PR from what the user pasted

/// A registered repo, enough to resolve a bare repo name.
public struct KnownRepo: Sendable, Equatable {
    public var owner: String
    public var repo: String

    public init(owner: String, repo: String) {
        self.owner = owner
        self.repo = repo
    }
}

// The sidecar's route validation uses the same character classes, so a
// locator can't produce a ref the API would reject.
private let ownerPattern = "[A-Za-z0-9][A-Za-z0-9-]{0,38}"
private let repoPattern = "[A-Za-z0-9._-]{1,100}"

private func firstMatch(_ pattern: String, _ text: String, caseInsensitive: Bool = false) -> [String]? {
    guard let re = try? NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : []),
          let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
    return (0..<m.numberOfRanges).map { i in
        Range(m.range(at: i), in: text).map { String(text[$0]) } ?? ""
    }
}

/// Reads a GitHub or Azure DevOps PR link. Nil for anything else, a
/// non-https link included.
public func parsePrLink(_ href: String) -> PrRef? {
    guard let url = URLComponents(string: href), url.scheme == "https", let host = url.host?.lowercased() else {
        return nil
    }
    // `percentEncodedPath` split before decoding, so an encoded `/` stays in its segment.
    var parts: [String] = []
    for segment in url.percentEncodedPath.split(separator: "/") {
        // A name of `.` or `..` would walk the sidecar route it lands in.
        guard let decoded = String(segment).removingPercentEncoding, !isDotSegment(decoded) else { return nil }
        parts.append(decoded)
    }
    func positive(_ s: String?) -> Int? {
        guard let s, !s.isEmpty, s.allSatisfy(\.isASCII), s.allSatisfy(\.isNumber), let n = Int(s), n > 0 else {
            return nil
        }
        return n
    }
    func at(_ i: Int) -> String? { parts.indices.contains(i) ? parts[i] : nil }
    if host == "github.com" {
        guard let owner = at(0), let repo = at(1), at(2) == "pull", let n = positive(at(3)) else { return nil }
        return .github(owner: owner, repo: repo, number: n)
    }
    // dev.azure.com carries the org as a path segment; a legacy account
    // carries it in the `{org}.visualstudio.com` subdomain.
    if host == "dev.azure.com" {
        guard let org = at(0), let project = at(1), at(2) == "_git", let repo = at(3), at(4) == "pullrequest",
              let id = positive(at(5)) else { return nil }
        return .azure(org: org, project: project, repo: repo, prId: id)
    }
    if host.hasSuffix(".visualstudio.com") {
        let org = String(host.split(separator: ".").first ?? "")
        guard !org.isEmpty, let project = at(0), at(1) == "_git", let repo = at(2), at(3) == "pullrequest",
              let id = positive(at(4)) else { return nil }
        return .azure(org: org, project: project, repo: repo, prId: id)
    }
    return nil
}

private func isDotSegment(_ s: String) -> Bool { s == "." || s == ".." }

/// The PRs a locator input could mean: a GitHub or Azure link,
/// `owner/repo#123` (or ` 123`, `/123`), or `repo#123` resolved against the
/// registered repos. Empty when nothing was recognized; several when a bare
/// repo name matches several owners, and the user should pick. A bare number
/// is refused: there is no repo to attach it to.
public func resolvePrLocator(_ input: String, knownRepos: [KnownRepo] = []) -> [PrRef] {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return [] }
    if let m = firstMatch("^(?:https?://)?(?:www\\.)?github\\.com/(\(ownerPattern))/(\(repoPattern))/pull/(\\d+)",
                          trimmed, caseInsensitive: true), let n = Int(m[3]), !isDotSegment(m[2]) {
        return [.github(owner: m[1], repo: m[2], number: n)]
    }
    // A link typed by hand may have no scheme. GitHub links matched above,
    // so this only picks up Azure ones.
    let hasScheme = trimmed.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil
    if let ref = parsePrLink(hasScheme ? trimmed : "https://\(trimmed)"), case .azure = ref { return [ref] }
    if let m = firstMatch("^(\(ownerPattern))/(\(repoPattern))(?:/|#|\\s+)#?(\\d+)$", trimmed), let n = Int(m[3]),
       !isDotSegment(m[2]) {
        return [.github(owner: m[1], repo: m[2], number: n)]
    }
    if let m = firstMatch("^(\(repoPattern))(?:#|\\s+)#?(\\d+)$", trimmed), let n = Int(m[2]), !isDotSegment(m[1]) {
        let name = m[1].lowercased()
        return knownRepos.filter { $0.repo.lowercased() == name }.map { .github(owner: $0.owner, repo: $0.repo, number: n) }
    }
    return []
}

// MARK: The PR's status

/// The badge on the PR bar.
public enum PrUiStatus: String, Sendable {
    case draft, ciFailing, awaitingReview, readyToMerge, merged, closed

    public var label: String {
        switch self {
        case .draft: return "Draft"
        case .ciFailing: return "CI failing"
        case .awaitingReview: return "Awaiting review"
        case .readyToMerge: return "Ready to merge"
        case .merged: return "Merged"
        case .closed: return "Closed"
        }
    }
}

private let passingConclusions: Set<String> = ["SUCCESS", "NEUTRAL", "SKIPPED"]

/// Merged and closed first, then failing CI, draft, ready to merge (no check
/// running and mergeable), else awaiting review. `fallbackState` and
/// `fallbackDraft` stand in until the detail loads.
public func derivePrUiStatus(_ detail: PrDetail?, fallbackState: String = "open",
                             fallbackDraft: Bool = false) -> PrUiStatus {
    let state = (detail?.state ?? fallbackState).lowercased()
    if state == "merged" || state == "completed" { return .merged }
    if state == "closed" || state == "abandoned" { return .closed }
    let checks = detail?.checks ?? []
    // A completed check with no conclusion counts as failing.
    if checks.contains(where: { checkTone($0) == .failed }) { return .ciFailing }
    if detail?.draft ?? fallbackDraft { return .draft }
    if !checks.contains(where: { $0.status != "COMPLETED" }) && detail?.mergeable == "MERGEABLE" { return .readyToMerge }
    return .awaitingReview
}

/// Which merge controls the bar shows.
public struct MergeControls: Sendable, Equatable {
    public var merge = false
    public var enableAuto = false
    public var disableAuto = false

    public init(merge: Bool = false, enableAuto: Bool = false, disableAuto: Bool = false) {
        self.merge = merge
        self.enableAuto = enableAuto
        self.disableAuto = disableAuto
    }
}

/// Azure lists no merge methods, so it gets none of these.
public func mergeControlsFor(_ detail: PrDetail?, status: PrUiStatus) -> MergeControls {
    guard let detail, status != .merged, status != .closed else { return MergeControls() }
    if detail.autoMergeEnabled { return MergeControls(disableAuto: detail.canDisableAutoMerge) }
    if detail.mergeMethods.isEmpty { return MergeControls() }
    let merge = status == .readyToMerge
    return MergeControls(merge: merge, enableAuto: !merge && detail.canEnableAutoMerge)
}

extension MergeMethod {
    public var menuLabel: String {
        switch self {
        case .merge: return "Create a merge commit"
        case .squash: return "Squash and merge"
        case .rebase: return "Rebase and merge"
        }
    }
}

public enum PrConflictState: Sendable, Equatable {
    case conflicts, computing, none
}

/// The sidecar decides what counts as conflicts, per provider; `mergeable`
/// alone would read an Azure policy rejection as conflicts.
public func prConflictState(_ detail: PrDetail?) -> PrConflictState {
    guard let detail else { return .none }
    if ["merged", "closed", "completed", "abandoned"].contains(detail.state.lowercased()) { return .none }
    if detail.hasConflicts { return .conflicts }
    if detail.mergeable == "UNKNOWN" { return .computing }
    return .none
}

/// What the conflict banner says once the agent has the conflicts.
public func handOffMessage(_ handOff: AgentHandOff) -> String {
    switch handOff.outcome {
    case "sent": return "Sent to the agent in “\(handOff.name)”."
    case "started": return "Started an agent in “\(handOff.name)” on it."
    case "created": return "Created “\(handOff.name)”; its agent starts on the conflicts once it is set up."
    default: return handOff.reason ?? ""
    }
}

/// The provider has moved past the checkout: someone pushed since it was fetched.
public func hasNewCommits(_ pr: ReviewWorkspacePr, providerHead: String?) -> Bool {
    guard pr.status == "ready", let head = pr.headSha, !head.isEmpty, let providerHead, !providerHead.isEmpty else {
        return false
    }
    return providerHead != head
}

// MARK: Checks

public enum CheckTone: Sendable { case running, passed, failed }

public func checkTone(_ check: PrCheck) -> CheckTone {
    if check.status != "COMPLETED" { return .running }
    return passingConclusions.contains((check.conclusion ?? "").uppercased()) ? .passed : .failed
}

public func checkGlyph(_ check: PrCheck) -> String {
    switch checkTone(check) {
    case .running: return "○"
    case .passed: return "✓"
    case .failed: return "✕"
    }
}

/// The conclusion, or the status while the check still runs.
public func checkOutcome(_ check: PrCheck) -> String {
    (check.conclusion ?? check.status).lowercased()
}

/// An http(s) link with control characters stripped, or nil for anything
/// else, so a copied link can't be a `javascript:` or `file:` one.
public func clipboardSafeURL(_ url: String?) -> String? {
    guard let url, !url.isEmpty else { return nil }
    let clean = clipboardSafeText(url)
    guard let scheme = URLComponents(string: clean)?.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
        return nil
    }
    return clean
}

/// One check as a pasteable line. The name is provider-supplied, so it is
/// stripped before it can forge a line of its own in the block.
public func checkLine(_ check: PrCheck) -> String {
    let line = "\(checkGlyph(check)) \(clipboardSafeText(check.name)) (\(checkOutcome(check)))"
    return clipboardSafeURL(check.url).map { "\(line) \($0)" } ?? line
}

public func checksClipboardText(_ checks: [PrCheck]) -> String {
    checks.map(checkLine).joined(separator: "\n")
}

// MARK: Reviewers

extension ReviewerState {
    public var label: String {
        switch self {
        case .approved: return "Approved"
        case .changesRequested: return "Changes requested"
        case .commented: return "Commented"
        case .pending: return "Awaiting review"
        case .dismissed: return "Dismissed"
        }
    }
}

/// Requested reviewers first, then changes requested, approved, commented,
/// dismissed, and the rest; by login within each.
public func sortReviewers(_ reviewers: [PrReviewer]) -> [PrReviewer] {
    func rank(_ r: PrReviewer) -> Int {
        if r.isRequested { return 0 }
        switch r.state {
        case .changesRequested: return 1
        case .approved: return 2
        case .commented: return 3
        case .dismissed: return 4
        case .pending: return 5
        }
    }
    return reviewers.sorted { a, b in
        let (ra, rb) = (rank(a), rank(b))
        return ra != rb ? ra < rb : a.login.localizedCompare(b.login) == .orderedAscending
    }
}

// MARK: Threads

/// General threads (no path) first, then one group per path in the order
/// the paths first appear.
public func groupThreadsByPath(_ threads: [PrThread]) -> (general: [PrThread], files: [(path: String, threads: [PrThread])]) {
    var general: [PrThread] = []
    var order: [String] = []
    var byPath: [String: [PrThread]] = [:]
    for t in threads {
        guard let path = t.path, !path.isEmpty else {
            general.append(t)
            continue
        }
        if byPath[path] == nil { order.append(path) }
        byPath[path, default: []].append(t)
    }
    return (general, order.map { ($0, byPath[$0] ?? []) })
}

/// Comments per path, replies and outdated threads included, for the nav's counts.
public func navCommentCounts(_ threads: [PrThread]) -> [String: Int] {
    var counts: [String: Int] = [:]
    for t in threads {
        guard let path = t.path else { continue }
        counts[path, default: 0] += t.comments.count
    }
    return counts
}

/// Paths with at least one unresolved thread.
public func navOpenThreadPaths(_ threads: [PrThread]) -> Set<String> {
    Set(threads.filter { !$0.isResolved }.compactMap(\.path))
}

// MARK: The workspace and its nav

/// "repo#12".
public func prLabel(_ ref: PrRef) -> String { "\(ref.repoName)#\(ref.number)" }

/// What a tab's owner label says: "#12" when every PR is from one repo,
/// since the number is then enough; "repo#12" otherwise.
public func tabOwnerLabel(_ pr: ReviewWorkspacePr, among prs: [ReviewWorkspacePr]) -> String {
    prs.allSatisfy({ $0.ref.displayRepo == pr.ref.displayRepo }) ? "#\(pr.ref.number)" : prLabel(pr.ref)
}

/// Anything about the workspace still moving, so it is worth reading again soon.
public func isSettling(_ ws: ReviewWorkspace) -> Bool {
    ws.status == "archiving" || ws.prs.contains {
        $0.status == "pending" || $0.status == "cloning" || $0.worktreeStatus == "pending"
            || $0.worktreeStatus == "checking-out" || $0.setupStatus == "running"
    }
}

/// What the nav says about a PR's checkout: nothing once it is ready,
/// otherwise the clone's progress or why it failed.
public func cloneStatusText(_ pr: ReviewWorkspacePr, lastLog: String?) -> String? {
    if pr.status == "error" { return pr.error ?? "Clone failed" }
    if pr.status == "pending" { return "Waiting to clone…" }
    if pr.status == "cloning" { return lastLog.map { "Cloning · \($0)" } ?? "Cloning…" }
    if pr.worktreeStatus == "checking-out" { return "Checking out…" }
    if pr.worktreeStatus == "error" { return pr.error ?? "Checkout failed" }
    return nil
}

/// The checkout is on disk but nobody has said whether its setup may run.
public func needsSetupAnswer(_ pr: ReviewWorkspacePr) -> Bool {
    pr.worktreeStatus == "ready" && pr.setupConsent == nil && pr.setupStatus == nil
}

/// "3h ago": the short form, for the workspace list.
public func shortAgo(_ iso: String?, now: Date = Date()) -> String {
    guard let iso, let date = parseISODate(iso) else { return "never opened" }
    let minutes = Int((now.timeIntervalSince(date) / 60).rounded())
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes)m ago" }
    let hours = Int((Double(minutes) / 60).rounded())
    if hours < 24 { return "\(hours)h ago" }
    return "\(Int((Double(hours) / 24).rounded()))d ago"
}

/// The list's order: most recently opened (or made) first.
public func sortedReviewWorkspaces(_ list: [ReviewWorkspace]) -> [ReviewWorkspace] {
    list.sorted { ($0.lastOpenedAt ?? $0.createdAt) > ($1.lastOpenedAt ?? $1.createdAt) }
}

/// Paths matching every space-separated word of `query`, in any case, so
/// "tabs diff" finds `src/review/tabs/DiffTab.tsx`. At most `max`.
public func filterPaths(_ paths: [String], query: String, max: Int = 200) -> [String] {
    let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    guard !words.isEmpty else { return [] }
    var out: [String] = []
    for p in paths {
        let lower = p.lowercased()
        if words.allSatisfy({ lower.contains($0) }) {
            out.append(p)
            if out.count >= max { break }
        }
    }
    return out
}

// MARK: Stack layers

/// The stack's layers the workspace could add: open PRs it doesn't hold
/// yet, bottom first. A merged layer is already in the trunk, and a branch
/// with no PR has nothing to check out.
public func addableLayers(_ stack: PrStack, held: Set<String>) -> [StackEntry] {
    stack.entries.filter { $0.hasPullRequest && $0.state == "open" && !held.contains($0.ref.key) }
}

/// Ticked to start with unless someone has already approved it.
public func pickedByDefault(_ entry: StackEntry) -> Bool { entry.reviewDecision != "approved" }

/// "Couldn't add a; b", from the layers that failed.
public func stackAddError(_ failures: [String]) -> String? {
    failures.isEmpty ? nil : "Couldn't add \(failures.joined(separator: "; "))"
}

// MARK: File trees

/// One row of a folder tree as drawn: a folder or file, and how deep it sits.
public struct FileTreeRow: Sendable, Equatable, Identifiable {
    public var node: FileTreeNode
    public var depth: Int
    public var id: String { node.path }
}

/// The rows a tree shows, flattened so a long tree can be drawn lazily.
/// A folder is open when `startsOpen`, unless its path is in `toggled`.
public func visibleTreeRows(_ nodes: [FileTreeNode], startsOpen: Bool, toggled: Set<String>) -> [FileTreeRow] {
    var rows: [FileTreeRow] = []
    func walk(_ nodes: [FileTreeNode], _ depth: Int) {
        for node in nodes {
            rows.append(FileTreeRow(node: node, depth: depth))
            if let children = node.children, startsOpen != toggled.contains(node.path) { walk(children, depth + 1) }
        }
    }
    walk(nodes, 0)
    return rows
}

// MARK: Setup consent

/// The branch as the setup prompt names it: with its owner when it lives in a fork.
public func setupBranchLabel(_ info: ReviewSetupInfo, fromFork: Bool) -> String {
    let branch = info.branch ?? "unknown"
    if fromFork, let author = info.author { return "\(author):\(branch)" }
    return branch
}

/// Nothing is offered to run unless both what and where are known: the
/// answer pins both, and a nil would pin nothing.
public func setupRunnable(_ info: ReviewSetupInfo?) -> Bool {
    guard let info, let script = info.script, !script.isEmpty, let head = info.headSha, !head.isEmpty else {
        return false
    }
    return true
}

/// The sandbox notes split into paragraphs on blank lines.
public func paragraphs(_ text: String?) -> [String] {
    guard let text else { return [] }
    return text.components(separatedBy: "\n")
        .split { $0.trimmingCharacters(in: .whitespaces).isEmpty }
        .map { $0.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
}

/// The ref for a workspace's linked PR: from its link when there is one,
/// which also covers Azure, else the repo's GitHub owner and name.
public func linkedPrRef(url: String?, owner: String, repo: String, number: Int) -> PrRef {
    url.flatMap(parsePrLink) ?? .github(owner: owner, repo: repo, number: number)
}

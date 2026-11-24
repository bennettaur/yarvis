import Foundation

// Where a file's review threads, new comments and line questions hang in a
// code view, and how this session's writes stay on screen until the
// provider's refetched threads carry them.

/// A line on one side that has something hanging below it.
public struct ZoneAnchor: Hashable, Sendable {
    public var side: DiffSide
    public var line: Int

    public init(side: DiffSide, line: Int) {
        self.side = side
        self.line = line
    }
}

/// Where a new comment goes: its last line, and its first for a range.
public struct CommentTarget: Hashable, Sendable {
    public var side: DiffSide
    public var line: Int
    public var startLine: Int?

    public init(side: DiffSide, line: Int, startLine: Int? = nil) {
        self.side = side
        self.line = line
        self.startLine = startLine
    }

    public var anchor: ZoneAnchor { ZoneAnchor(side: side, line: line) }
}

/// The composer's range after a shift-click on `line`.
public func extendTarget(_ current: CommentTarget, to line: Int) -> CommentTarget {
    let first = min(current.startLine ?? current.line, current.line, line)
    let last = max(current.line, line)
    return first < last ? CommentTarget(side: current.side, line: last, startLine: first) : current
}

private func fileName(_ side: DiffSide) -> String { side == .left ? "old" : "new" }

/// "lines 4–9" for a range, "line 4" otherwise, with the old file named. A
/// range that starts in one file and ends in the other names both, since its
/// two numbers count lines in different files.
public func describeLines(line: Int, side: DiffSide, startLine: Int? = nil, startSide: DiffSide? = nil) -> String {
    let startSide = startSide ?? side
    if let startLine, startSide != side {
        return "\(fileName(startSide)) line \(startLine) to \(fileName(side)) line \(line)"
    }
    let lines = startLine.map { $0 < line ? "lines \($0)–\(line)" : "line \(line)" } ?? "line \(line)"
    return side == .left ? "\(lines) (old)" : lines
}

/// Whether a comment's position is worth spelling out: a plain comment on
/// one new-file line isn't, since the line it hangs under says as much.
public func needsLineLabel(side: DiffSide, startLine: Int?) -> Bool {
    startLine != nil || side == .left
}

/// "GitHub" or "Azure DevOps" for a link into either; nil for anything else,
/// which then gets no link.
public func threadProviderName(_ url: String) -> String? {
    guard let parsed = URL(string: url), ["http", "https"].contains(parsed.scheme?.lowercased() ?? ""),
          let host = parsed.host?.lowercased() else { return nil }
    if host == "github.com" || host.hasSuffix(".github.com") { return "GitHub" }
    if host == "dev.azure.com" || host.hasSuffix(".visualstudio.com") { return "Azure DevOps" }
    return nil
}

// MARK: Optimistic writes

/// A comment body as compared with the provider's echo: its line endings
/// and the composer's trim don't count.
public func comparableBody(_ body: String) -> String {
    body.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
}

/// A reply posted this session, shown until the refetched thread carries it.
public struct PostedReply: Hashable, Sendable {
    public var id: Int
    public var threadId: String
    public var body: String
    /// The thread's comment count when posted. Only a later comment can be
    /// this reply: a short one ("done", "+1") often repeats an earlier one.
    public var afterCount: Int

    public init(id: Int, threadId: String, body: String, afterCount: Int) {
        self.id = id
        self.threadId = threadId
        self.body = body
        self.afterCount = afterCount
    }
}

public func replyIsPending(_ reply: PostedReply, threads: [String: PrThread]) -> Bool {
    guard let thread = threads[reply.threadId] else { return true }
    let body = comparableBody(reply.body)
    return !thread.comments.dropFirst(reply.afterCount).contains { comparableBody($0.body) == body }
}

/// The resolve and unresolve overrides the server hasn't agreed with yet.
public func pendingOverrides(_ overrides: [String: Bool], threads: [String: PrThread]) -> [String: Bool] {
    overrides.filter { threads[$0.key]?.isResolved != $0.value }
}

/// A line comment posted this session, shown until a thread on its line carries it.
public struct PostedLineComment: Hashable, Sendable {
    public var id: Int
    public var target: CommentTarget
    public var body: String

    public init(id: Int, target: CommentTarget, body: String) {
        self.id = id
        self.target = target
        self.body = body
    }
}

/// The posted comments no thread on the same side and line carries yet.
public func pendingLineComments(_ posted: [PostedLineComment], threads: [PrThread]) -> [PostedLineComment] {
    let byAnchor = threadsByAnchor(threads)
    return posted.filter { p in
        !(byAnchor[p.target.anchor] ?? []).contains { thread in
            thread.comments.contains { comparableBody($0.body) == comparableBody(p.body) }
        }
    }
}

/// A file's placed threads by the side and line they hang below.
public func threadsByAnchor(_ threads: [PrThread]) -> [ZoneAnchor: [PrThread]] {
    var map: [ZoneAnchor: [PrThread]] = [:]
    for thread in threads {
        guard let line = thread.line else { continue }
        map[ZoneAnchor(side: thread.side, line: line), default: []].append(thread)
    }
    return map
}

// MARK: Placing things in a file

/// A file's threads split into those a code view can place under a line and
/// those it can't: outdated, or with no line left on the current diff.
public func splitThreads(_ threads: [PrThread], path: String) -> (inline: [PrThread], outdated: [PrThread]) {
    var inline: [PrThread] = []
    var outdated: [PrThread] = []
    for thread in threads where thread.path == path {
        if thread.isOutdated || thread.line == nil { outdated.append(thread) } else { inline.append(thread) }
    }
    return (inline, outdated)
}

/// Every line with comments below it, one per side and line, top to bottom
/// with the old side first on a shared line.
public func commentAnchors(threads: [PrThread], pending: [ZoneAnchor], composer: ZoneAnchor?) -> [ZoneAnchor] {
    var set = Set<ZoneAnchor>()
    for t in threads { if let line = t.line { set.insert(ZoneAnchor(side: t.side, line: line)) } }
    set.formUnion(pending)
    if let composer { set.insert(composer) }
    return set.sorted { ($0.line, $0.side.rawValue) < ($1.line, $1.side.rawValue) }
}

/// The new-file lines with an answer below them, or the question composer.
/// An answer hangs under the last line it was asked about.
public func insightLines(_ insights: [PrInsight], asking: Int?) -> [Int] {
    var lines = Set(insights.map(\.endLine))
    if let asking { lines.insert(asking) }
    return lines.sorted()
}

public func insightsAtLine(_ insights: [PrInsight], line: Int) -> [PrInsight] {
    insights.filter { $0.endLine == line }
}

/// The insights grouped by path, newest first as the list holds them.
public func insightsByPath(_ insights: [PrInsight]) -> [String: [PrInsight]] {
    Dictionary(grouping: insights, by: \.path)
}

/// Answered against a head the PR has since moved past. An unknown head
/// (empty) never makes one stale.
public func insightIsStale(_ insight: PrInsight, currentSha: String) -> Bool {
    !currentSha.isEmpty && insight.headSha != currentSha
}

/// Lines `start` to `end` (1-based, inclusive) of `content`, sent with a
/// question so the agent sees what the reader sees. Split as the code view
/// splits (`splitFileLines`), so a CRLF file's lines go without their "\r".
public func linesText(_ content: String, start: Int, end: Int) -> String {
    let lines = splitFileLines(content)
    let from = max(0, start - 1)
    let to = min(lines.count, max(start, end))
    guard from < to else { return "" }
    return lines[from..<to].joined(separator: "\n")
}

/// "1 outdated thread", "3 outdated threads".
public func outdatedThreadsLabel(_ threads: [PrThread]) -> String {
    "\(threads.count) outdated \(threads.count == 1 ? "thread" : "threads")"
}

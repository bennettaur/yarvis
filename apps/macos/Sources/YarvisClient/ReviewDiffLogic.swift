import Foundation

// The review's diff and file views, worked out apart from AppKit: the line
// diff of two file versions, how its rows pair up side by side, which
// unchanged stretches fold, and the column maths a monospaced view needs.

/// A file's lines, split on "\n" with a trailing "\r" dropped. A final
/// newline doesn't add an empty last line.
public func splitFileLines(_ content: String) -> [String] {
    if content.isEmpty { return [] }
    // Split on UTF-16, not Characters: Swift reads "\r\n" as one Character.
    var lines = content.components(separatedBy: "\n").map { line in
        line.utf16.last == 13 ? String(line.utf16.dropLast()) ?? line : line
    }
    if content.hasSuffix("\n") { lines.removeLast() }
    return lines
}

/// One edit of a line diff; indexes are 0-based into the old and new lines.
public enum LineEdit: Equatable, Sendable {
    case equal(old: Int, new: Int)
    case delete(old: Int)
    case insert(new: Int)
}

/// Past this many differing lines the diff stops looking for the shortest
/// edit and shows the rest as replaced, which keeps a rewrite of a big file
/// from costing seconds and hundreds of megabytes.
public let maxDiffEdits = 4_000

/// The line diff from `old` to `new` (Myers), with each changed stretch as
/// its deletions followed by its insertions.
public func lineDiff(old: [String], new: [String], maxEdits: Int = maxDiffEdits) -> [LineEdit] {
    var prefix = 0
    while prefix < old.count && prefix < new.count && old[prefix] == new[prefix] { prefix += 1 }
    var suffix = 0
    while suffix < old.count - prefix && suffix < new.count - prefix
        && old[old.count - 1 - suffix] == new[new.count - 1 - suffix] { suffix += 1 }

    // Interned so the search compares integers.
    var ids: [String: Int] = [:]
    let intern = { (s: String) -> Int in
        if let id = ids[s] { return id }
        let id = ids.count
        ids[s] = id
        return id
    }
    let a = old[prefix..<(old.count - suffix)].map(intern)
    let b = new[prefix..<(new.count - suffix)].map(intern)

    var edits: [LineEdit] = (0..<prefix).map { .equal(old: $0, new: $0) }
    let middle = myers(a, b, maxEdits: maxEdits)
        ?? (a.indices.map { LineEdit.delete(old: $0) } + b.indices.map { LineEdit.insert(new: $0) })
    for edit in middle {
        switch edit {
        case .equal(let o, let n): edits.append(.equal(old: o + prefix, new: n + prefix))
        case .delete(let o): edits.append(.delete(old: o + prefix))
        case .insert(let n): edits.append(.insert(new: n + prefix))
        }
    }
    let oldTail = old.count - suffix
    let newTail = new.count - suffix
    edits += (0..<suffix).map { .equal(old: oldTail + $0, new: newTail + $0) }
    return groupedRuns(edits)
}

private func myers(_ a: [Int], _ b: [Int], maxEdits: Int) -> [LineEdit]? {
    let n = a.count, m = b.count
    if n == 0 && m == 0 { return [] }
    let maxD = min(n + m, maxEdits)
    let offset = maxD + 1
    var v = [Int](repeating: 0, count: 2 * maxD + 3)
    // trace[d] is `v` before step d, kept only over the diagonals step d reads.
    var trace: [[Int]] = []
    var found = -1
    search: for d in 0...maxD {
        trace.append(Array(v[(offset - d)...(offset + d)]))
        for k in stride(from: -d, through: d, by: 2) {
            var x: Int
            if k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1]) {
                x = v[offset + k + 1]
            } else {
                x = v[offset + k - 1] + 1
            }
            var y = x - k
            while x < n && y < m && a[x] == b[y] {
                x += 1
                y += 1
            }
            v[offset + k] = x
            if x >= n && y >= m {
                found = d
                break search
            }
        }
    }
    guard found >= 0 else { return nil }

    var edits: [LineEdit] = []
    var x = n, y = m
    for d in stride(from: found, through: 1, by: -1) {
        let prev = trace[d]
        let at = { (k: Int) in prev[k + d] }
        let k = x - y
        let prevK = (k == -d || (k != d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1
        let prevX = at(prevK)
        let prevY = prevX - prevK
        while x > prevX && y > prevY {
            x -= 1
            y -= 1
            edits.append(.equal(old: x, new: y))
        }
        if x == prevX {
            y -= 1
            edits.append(.insert(new: y))
        } else {
            x -= 1
            edits.append(.delete(old: x))
        }
    }
    while x > 0 && y > 0 {
        x -= 1
        y -= 1
        edits.append(.equal(old: x, new: y))
    }
    return edits.reversed()
}

/// Each run of changes as its deletions, then its insertions.
private func groupedRuns(_ edits: [LineEdit]) -> [LineEdit] {
    var out: [LineEdit] = []
    var dels: [LineEdit] = []
    var ins: [LineEdit] = []
    func flush() {
        out += dels + ins
        dels = []
        ins = []
    }
    for edit in edits {
        switch edit {
        case .equal: flush(); out.append(edit)
        case .delete: dels.append(edit)
        case .insert: ins.append(edit)
        }
    }
    flush()
    return out
}

/// One row of a code view. Line numbers are 1-based; a nil side has no line
/// in that row. `changed` is false for a line both versions share.
public struct DiffPair: Equatable, Sendable, Hashable {
    public var old: Int?
    public var new: Int?
    public var changed: Bool

    public init(old: Int?, new: Int?, changed: Bool) {
        self.old = old
        self.new = new
        self.changed = changed
    }
}

public enum DiffLayout: Sendable {
    /// One column: a removed line, then an added one.
    case unified
    /// Two columns, the nth removed line of a run beside its nth added line.
    case split
}

/// The rows of a diff in `layout`.
public func diffPairs(_ edits: [LineEdit], layout: DiffLayout) -> [DiffPair] {
    var pairs: [DiffPair] = []
    var dels: [Int] = []
    var ins: [Int] = []
    func flush() {
        switch layout {
        case .unified:
            pairs += dels.map { DiffPair(old: $0 + 1, new: nil, changed: true) }
            pairs += ins.map { DiffPair(old: nil, new: $0 + 1, changed: true) }
        case .split:
            for i in 0..<max(dels.count, ins.count) {
                pairs.append(DiffPair(old: i < dels.count ? dels[i] + 1 : nil,
                                      new: i < ins.count ? ins[i] + 1 : nil, changed: true))
            }
        }
        dels = []
        ins = []
    }
    for edit in edits {
        switch edit {
        case .equal(let o, let n):
            flush()
            pairs.append(DiffPair(old: o + 1, new: n + 1, changed: false))
        case .delete(let o): dels.append(o)
        case .insert(let n): ins.append(n)
        }
    }
    flush()
    return pairs
}

/// A whole file as rows, every line on the new side.
public func filePairs(lineCount: Int) -> [DiffPair] {
    (0..<lineCount).map { DiffPair(old: nil, new: $0 + 1, changed: false) }
}

// MARK: Folding

/// How much of a folded stretch has been opened from each end.
public struct FoldReveal: Equatable, Sendable {
    public var top = 0
    public var bottom = 0

    public init(top: Int = 0, bottom: Int = 0) {
        self.top = top
        self.bottom = bottom
    }

    /// Opens everything.
    public static let all = FoldReveal(top: Int.max / 4, bottom: 0)
}

/// Lines shown around each change, and how many hidden lines a fold needs.
public let foldContextLines = 3
public let minFoldedLines = 3
/// Lines one "show more" opens.
public let foldExpandStep = 20

public enum CodeRow: Equatable, Sendable, Hashable {
    /// An index into the pairs.
    case pair(Int)
    /// A folded stretch: `id` is the first hidden pair's index before any
    /// reveal (stable across reveals), `hidden` how many pairs it hides.
    case fold(id: Int, hidden: Int)
}

/// The rows with unchanged stretches folded, keeping `context` lines around
/// each change and each pair in `keep` (a line with a thread, or one asked
/// to be shown). A stretch shorter than `minHidden` stays open.
public func foldedRows(_ pairs: [DiffPair], keep: Set<Int> = [], reveals: [Int: FoldReveal] = [:],
                       context: Int = foldContextLines, minHidden: Int = minFoldedLines) -> [CodeRow] {
    let n = pairs.count
    var shown = [Bool](repeating: false, count: n)
    for i in 0..<n where pairs[i].changed || keep.contains(i) {
        for j in max(0, i - context)...min(n - 1, i + context) { shown[j] = true }
    }

    var rows: [CodeRow] = []
    var i = 0
    while i < n {
        if shown[i] {
            rows.append(.pair(i))
            i += 1
            continue
        }
        var end = i
        while end < n && !shown[end] { end += 1 }
        let count = end - i
        if count < minHidden {
            rows += (i..<end).map { .pair($0) }
        } else {
            let reveal = reveals[i] ?? FoldReveal()
            let top = min(reveal.top, count)
            let bottom = min(reveal.bottom, count - top)
            let hidden = count - top - bottom
            rows += (i..<(i + top)).map { .pair($0) }
            if hidden > 0 { rows.append(.fold(id: i, hidden: hidden)) }
            rows += ((end - bottom)..<end).map { .pair($0) }
        }
        i = end
    }
    return rows
}

// MARK: Columns

/// Tab stops every this many columns.
public let codeTabWidth = 4

/// How many monospaced columns a line takes, tabs to the next stop.
public func displayColumns(_ line: String) -> Int {
    var col = 0
    for u in line.utf16 {
        if u == 9 { col += codeTabWidth - col % codeTabWidth } else if !(u >= 0xDC00 && u <= 0xDFFF) { col += 1 }
    }
    return col
}

/// The UTF-16 offset of the character at `column`, or the line's length
/// past its end.
public func utf16Offset(atColumn column: Int, in line: String) -> Int {
    var col = 0
    var offset = 0
    for u in line.utf16 {
        let width = u == 9 ? codeTabWidth - col % codeTabWidth : (u >= 0xDC00 && u <= 0xDFFF ? 0 : 1)
        if width > 0 && column < col + width { return offset }
        col += width
        offset += 1
    }
    return offset
}

/// How many wrapped rows a line of `columns` takes at `perRow` columns a row.
public func wrappedRows(columns: Int, perRow: Int) -> Int {
    guard perRow > 0 else { return 1 }
    return max(1, (columns + perRow - 1) / perRow)
}

// MARK: Symbols

/// The identifier at `offset` (UTF-16) in `line`, if the click landed on one.
/// A trailing `?` or `!` is kept, as Ruby and Swift names carry them.
public func identifier(in line: String, at offset: Int) -> String? {
    let units = Array(line.utf16)
    func part(_ u: UInt16) -> Bool {
        (u >= 65 && u <= 90) || (u >= 97 && u <= 122) || (u >= 48 && u <= 57) || u == 95 || u == 36
    }
    guard offset >= 0, offset < units.count else { return nil }
    var at = offset
    if !part(units[at]) {
        // On a trailing `?`/`!`, read the name before it.
        guard (units[at] == 63 || units[at] == 33), at > 0, part(units[at - 1]) else { return nil }
        at -= 1
    }
    var start = at
    while start > 0 && part(units[start - 1]) { start -= 1 }
    var end = at + 1
    while end < units.count && part(units[end]) { end += 1 }
    if end < units.count && (units[end] == 63 || units[end] == 33) { end += 1 }
    let word = String(utf16CodeUnits: Array(units[start..<end]), count: end - start)
    return isSymbolName(word) ? word : nil
}

/// Whether `word` is something worth a symbol search.
public func isSymbolName(_ word: String) -> Bool {
    word.range(of: #"^[A-Za-z_$][A-Za-z0-9_$]*[?!]?$"#, options: .regularExpression) != nil
}

/// The tab a jump to `path` opens: the diff when the PR changes the file, the
/// plain file when it's in the tree, nothing for a path the PR doesn't have
/// (search results come from PR code, so they're checked, not trusted).
public func navigationTab(prId: String, path: String, line: Int?, changed: Set<String>,
                          tree: Set<String>) -> ReviewTabSpec? {
    if changed.contains(path) { return .diff(prId: prId, path: path, revealLine: line) }
    if tree.contains(path) { return .file(prId: prId, path: path, revealLine: line) }
    return nil
}

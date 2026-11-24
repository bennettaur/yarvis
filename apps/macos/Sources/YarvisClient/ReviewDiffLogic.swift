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
public let maxDiffEdits = 2_000

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

/// How many columns a scalar takes in a monospaced view: 0 for combining
/// marks and joiners, 2 for East Asian wide characters and emoji, 1 otherwise.
public func columnWidth(_ scalar: Unicode.Scalar) -> Int {
    let v = scalar.value
    if v < 0x300 { return 1 }
    switch scalar.properties.generalCategory {
    case .nonspacingMark, .enclosingMark, .format: return 0
    default: break
    }
    if (0xFE00...0xFE0F).contains(v) || (0xE0100...0xE01EF).contains(v) { return 0 }
    if scalar.properties.isEmojiPresentation { return 2 }
    let wide: [ClosedRange<UInt32>] = [
        0x1100...0x115F, 0x2E80...0x303E, 0x3041...0x33FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xA000...0xA4CF,
        0xAC00...0xD7A3, 0xF900...0xFAFF, 0xFE30...0xFE4F, 0xFF00...0xFF60, 0xFFE0...0xFFE6,
        0x1F300...0x1F64F, 0x1F900...0x1F9FF, 0x20000...0x3FFFD,
    ]
    return wide.contains { $0.contains(v) } ? 2 : 1
}

/// How many monospaced columns a line takes, tabs to the next stop.
public func displayColumns(_ line: String) -> Int {
    var col = 0
    for scalar in line.unicodeScalars {
        col += scalar == "\t" ? codeTabWidth - col % codeTabWidth : columnWidth(scalar)
    }
    return col
}

/// The UTF-16 offset of the character at `column`, or the line's length
/// past its end.
public func utf16Offset(atColumn column: Int, in line: String) -> Int {
    var col = 0
    var offset = 0
    for scalar in line.unicodeScalars {
        let width = scalar == "\t" ? codeTabWidth - col % codeTabWidth : columnWidth(scalar)
        if width > 0 && column < col + width { return offset }
        col += width
        offset += scalar.utf16.count
    }
    return offset
}

/// Lines longer than this many columns are drawn cut off, since wrapping
/// a minified bundle's one line fills screens with nothing readable.
public let maxDrawnColumns = 5_000

/// The line as drawn: a carriage return or Unicode line or paragraph
/// separator inside it shows as a visible mark instead of breaking the
/// line, keeping every UTF-16 offset where it was.
public func drawableLine(_ line: String) -> String {
    guard line.unicodeScalars.contains(where: { lineBreakMarks[$0] != nil }) else { return line }
    var out = String.UnicodeScalarView()
    for scalar in line.unicodeScalars { out.append(lineBreakMarks[scalar] ?? scalar) }
    return String(out)
}

private let lineBreakMarks: [Unicode.Scalar: Unicode.Scalar] = [
    "\r": "\u{240D}", "\u{0085}": "\u{2424}", "\u{2028}": "\u{2424}", "\u{2029}": "\u{00B6}",
    "\u{000B}": "\u{240B}", "\u{000C}": "\u{240C}",
]

/// Why two versions whose bytes differ show no changed line: the change is
/// only in line endings, the newline at the end, or how characters are
/// encoded. Nil when the bytes are the same.
public func invisibleChangeNote(old: String, new: String) -> String? {
    // Bytes, not `==`: String equality treats "é" and "e\u{301}" as equal.
    guard !old.utf8.elementsEqual(new.utf8) else { return nil }
    var notes: [String] = []
    if old.utf8.contains(13) != new.utf8.contains(13) { notes.append("Line endings changed.") }
    let oldEnds = old.utf8.last == 10, newEnds = new.utf8.last == 10
    if oldEnds && !newEnds && !new.isEmpty { notes.append("No newline at end of file.") }
    if !oldEnds && newEnds && !old.isEmpty { notes.append("Newline added at end of file.") }
    return notes.isEmpty ? "The versions differ only in how some characters are encoded." : notes.joined(separator: " ")
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

// MARK: Report marks

/// How the verification report marks a new-file line.
public struct ReviewLineMark: Equatable, Sendable {
    /// Inside the must-read range.
    public var mustRead = false
    /// Cited by at least one of the report's notes.
    public var cited = false
    /// Plain text: "Must read: …" and each note's own text, one per line.
    public var hover: String?

    public init(mustRead: Bool = false, cited: Bool = false, hover: String? = nil) {
        self.mustRead = mustRead
        self.cited = cited
        self.hover = hover
    }

    mutating func addHover(_ text: String) {
        hover = hover.map { $0 + "\n" + text } ?? text
    }
}

/// Past this many lines a must-read range is a model's mistake, not a range.
private let maxMarkedRange = 5_000

/// The must-read range and each line a note cites, with their hover text.
/// A must-read with no lines marks nothing.
public func reviewLineMarks(mustRead: VerificationMustRead?, notes: [FileNote]) -> [Int: ReviewLineMark] {
    var marks: [Int: ReviewLineMark] = [:]
    if let mustRead, let lines = mustRead.lines, lines.start >= 1, lines.start <= lines.end {
        for line in lines.start...min(lines.end, lines.start + maxMarkedRange) {
            marks[line, default: ReviewLineMark()].mustRead = true
            marks[line]?.addHover("Must read: \(mustRead.reason)")
        }
    }
    for note in notes {
        marks[note.line, default: ReviewLineMark()].cited = true
        marks[note.line]?.addHover(note.hoverText)
    }
    return marks
}

// MARK: Find in file

/// Where a search term appears in one line: UTF-16 offset and length.
public struct LineMatch: Equatable, Sendable {
    public var line: Int
    public var start: Int
    public var length: Int

    public init(line: Int, start: Int, length: Int) {
        self.line = line
        self.start = start
        self.length = length
    }
}

/// Stops a one-letter search in a huge file from building a huge list.
public let maxFindMatches = 10_000

/// Every case-insensitive occurrence of `query` in `lines` (1-based line
/// numbers), in order.
public func findMatches(_ query: String, in lines: [String], limit: Int = maxFindMatches) -> [LineMatch] {
    guard !query.isEmpty else { return [] }
    var out: [LineMatch] = []
    for (i, line) in lines.enumerated() {
        let ns = line as NSString
        var range = NSRange(location: 0, length: ns.length)
        while range.length > 0 {
            let found = ns.range(of: query, options: [.caseInsensitive], range: range)
            guard found.location != NSNotFound, found.length > 0 else { break }
            out.append(LineMatch(line: i + 1, start: found.location, length: found.length))
            if out.count >= limit { return out }
            let next = found.location + found.length
            range = NSRange(location: next, length: ns.length - next)
        }
    }
    return out
}

import Foundation
import YarvisClient

/// One version of a file split into lines, with each line's width in
/// columns. `key` names the content, so its colouring is cached under it.
final class CodeLines: Sendable {
    let key: String
    let lines: [String]
    let columns: [Int]
    let language: String?
    let text: String

    init(key: String, content: String, language: String?) {
        self.key = key
        text = content
        lines = splitFileLines(content)
        columns = lines.map(displayColumns)
        self.language = language
    }

    /// The 1-based line, if the file has it.
    func line(_ n: Int?) -> String? {
        guard let n, n >= 1, n <= lines.count else { return nil }
        return lines[n - 1]
    }

    func columns(_ n: Int?) -> Int {
        guard let n, n >= 1, n <= columns.count else { return 0 }
        return columns[n - 1]
    }
}

enum CodeViewMode: Sendable {
    case file, unified, split
}

/// What a code view shows: a whole file, or two versions of one as a diff.
/// Built off the main thread, since a diff of a big file takes a while.
struct ReviewCodeDocument: Sendable {
    let id: String
    let mode: CodeViewMode
    /// Nil for a whole file.
    let old: CodeLines?
    let new: CodeLines
    let pairs: [DiffPair]
    /// The pair holding each line, by 1-based line number.
    let oldIndex: [Int: Int]
    let newIndex: [Int: Int]

    private init(id: String, mode: CodeViewMode, old: CodeLines?, new: CodeLines, pairs: [DiffPair]) {
        self.id = id
        self.mode = mode
        self.old = old
        self.new = new
        self.pairs = pairs
        var oldIndex: [Int: Int] = [:]
        var newIndex: [Int: Int] = [:]
        for (i, p) in pairs.enumerated() {
            if let o = p.old { oldIndex[o] = i }
            if let n = p.new { newIndex[n] = i }
        }
        self.oldIndex = oldIndex
        self.newIndex = newIndex
    }

    static func file(key: String, content: String, path: String) -> ReviewCodeDocument {
        let lines = CodeLines(key: key, content: content, language: languageForPath(path))
        return ReviewCodeDocument(id: "file:\(key)", mode: .file, old: nil, new: lines,
                                  pairs: filePairs(lineCount: lines.lines.count))
    }

    static func diff(oldKey: String, old: String, newKey: String, new: String, path: String,
                     split: Bool) -> ReviewCodeDocument {
        let language = languageForPath(path)
        let a = CodeLines(key: oldKey, content: old, language: language)
        let b = CodeLines(key: newKey, content: new, language: language)
        let edits = lineDiff(old: a.lines, new: b.lines)
        return ReviewCodeDocument(id: "diff:\(oldKey)|\(newKey)|\(split)", mode: split ? .split : .unified,
                                  old: a, new: b, pairs: diffPairs(edits, layout: split ? .split : .unified))
    }

    /// The pair showing `line` on `side`.
    func pairIndex(side: DiffSide, line: Int) -> Int? {
        side == .left ? oldIndex[line] : newIndex[line]
    }
}

/// Reads shared by every code tab: file versions, built documents and their
/// colouring, kept for the most recent few dozen so switching tabs or diff
/// modes doesn't fetch or diff again. Keys name the commit they were read at,
/// so nothing here goes stale.
@MainActor
final class ReviewCodeCache {
    static let shared = ReviewCodeCache()

    private var values: [String: any Sendable] = [:]
    private var order: [String] = []
    private var inFlight: [String: Task<any Sendable, Error>] = [:]
    private let capacity = 80

    /// The value under `key`, read once however many tabs ask at the same time.
    func value<T: Sendable>(_ key: String, _ read: @escaping @Sendable () async throws -> T) async throws -> T {
        if let hit = values[key] as? T {
            touch(key)
            return hit
        }
        let task: Task<any Sendable, Error>
        if let running = inFlight[key] {
            task = running
        } else {
            task = Task { try await read() }
            inFlight[key] = task
        }
        do {
            let value = try await task.value
            inFlight[key] = nil
            store(key, value)
            guard let typed = value as? T else { throw CancellationError() }
            return typed
        } catch {
            inFlight[key] = nil
            throw error
        }
    }

    /// The value under `key` if it's already here, for a first paint without a spinner.
    func cached<T>(_ key: String) -> T? { values[key] as? T }

    /// A document built off the main thread.
    func document(_ id: String, _ build: @escaping @Sendable () -> ReviewCodeDocument) async -> ReviewCodeDocument {
        (try? await value("doc:\(id)") { await Task.detached(priority: .userInitiated) { build() }.value })
            ?? build()
    }

    /// The colouring for one version, or nil when it isn't worth colouring.
    func highlights(_ lines: CodeLines) async -> [[SyntaxSpan]]? {
        guard let language = lines.language else { return nil }
        let text = lines.text
        let spans: [[SyntaxSpan]]?? = try? await value("hl:\(lines.key)") {
            await Task.detached(priority: .utility) { highlightLines(text, language: language) }.value
        }
        return spans ?? nil
    }

    private func store(_ key: String, _ value: any Sendable) {
        values[key] = value
        touch(key)
        while order.count > capacity {
            values[order.removeFirst()] = nil
        }
    }

    private func touch(_ key: String) {
        order.removeAll { $0 == key }
        order.append(key)
    }
}

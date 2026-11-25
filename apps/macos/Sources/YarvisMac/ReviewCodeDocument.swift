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
/// colouring, kept within a memory budget, oldest dropped first, so switching
/// tabs or diff modes doesn't fetch or diff again. Keys name the commit they
/// were read at, so nothing here goes stale.
@MainActor
final class ReviewCodeCache {
    static let shared = ReviewCodeCache()

    enum Failure: Error {
        /// Two callers used one key for different types: a bug in the keys.
        case typeMismatch(key: String)
    }

    private var values: [String: (value: any Sendable, cost: Int)] = [:]
    private var order: [String] = []
    private var total = 0
    private var inFlight: [String: Task<any Sendable, Error>] = [:]
    /// Bumped by `clear()`, so a read that started before it isn't stored after.
    private var generation = 0
    /// Roughly how many bytes the cache holds before dropping the oldest.
    private let budget = 96 << 20
    /// A value bigger than this is returned but not kept.
    private let largest = 24 << 20

    /// The value under `key`, read once however many tabs ask at the same time.
    func value<T: Sendable>(_ key: String, _ read: @escaping @Sendable () async throws -> T) async throws -> T {
        if let hit = values[key] {
            guard let typed = hit.value as? T else { throw mismatch(key) }
            touch(key)
            return typed
        }
        let task: Task<any Sendable, Error>
        if let running = inFlight[key] {
            task = running
        } else {
            task = Task { try await read() }
            inFlight[key] = task
        }
        let started = generation
        do {
            let value = try await task.value
            if generation == started {
                inFlight[key] = nil
                store(key, value)
            }
            guard let typed = value as? T else { throw mismatch(key) }
            return typed
        } catch {
            if generation == started { inFlight[key] = nil }
            throw error
        }
    }

    private func mismatch(_ key: String) -> Failure {
        assertionFailure("ReviewCodeCache: \(key) holds another type")
        return .typeMismatch(key: key)
    }

    /// Drops everything, for when the page stops or another workspace opens.
    func clear() {
        generation += 1
        for task in inFlight.values { task.cancel() }
        inFlight = [:]
        values = [:]
        order = []
        total = 0
    }

    /// A document built off the main thread.
    func document(_ id: String, _ build: @escaping @Sendable () -> ReviewCodeDocument) async -> ReviewCodeDocument {
        let built: @Sendable () async -> ReviewCodeDocument = {
            await Task.detached(priority: .userInitiated) { build() }.value
        }
        if let cached = try? await value("doc:\(id)", built) { return cached }
        return await built()
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
        let cost = Self.cost(value)
        guard cost <= largest else { return }
        if let old = values[key] { total -= old.cost }
        values[key] = (value, cost)
        total += cost
        touch(key)
        while total > budget, let oldest = order.first {
            order.removeFirst()
            total -= values.removeValue(forKey: oldest)?.cost ?? 0
        }
    }

    /// Roughly how many bytes a value holds, counting its text.
    private static func cost(_ value: any Sendable) -> Int {
        switch value {
        case let file as ReviewFileContent: return file.content.utf8.count + 256
        case let view as SinceFileView:
            return (view.original?.content.utf8.count ?? 0) + (view.modified?.content.utf8.count ?? 0)
                + view.patch.utf8.count + 256
        case let diff as CommitFileDiff:
            return (diff.original?.content.utf8.count ?? 0) + (diff.modified?.content.utf8.count ?? 0)
                + diff.patch.utf8.count + 256
        case let files as CommitFiles: return files.files.count * 200 + 256
        // Text twice per side (whole and split into lines), plus the rows.
        case let doc as ReviewCodeDocument:
            return 2 * ((doc.old?.text.utf8.count ?? 0) + doc.new.text.utf8.count) + doc.pairs.count * 40
        case let spans as [[SyntaxSpan]]?:
            return (spans ?? []).reduce(0) { $0 + 16 + $1.count * MemoryLayout<SyntaxSpan>.stride }
        default: return 1_024
        }
    }

    private func touch(_ key: String) {
        order.removeAll { $0 == key }
        order.append(key)
    }
}

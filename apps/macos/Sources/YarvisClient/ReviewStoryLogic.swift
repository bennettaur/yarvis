import Foundation

// Story mode: the PR read theme by theme rather than file by file, the work
// that matters first. The chapters are the change map's themes, which the
// sidecar already orders core, then supporting, then outliers, riskiest first
// within each; files no theme names close the story so nothing is skipped.

public struct StoryChapter: Sendable, Equatable, Identifiable {
    /// The theme's position and title, or the leftovers' fixed key.
    public var id: String
    public var title: String
    public var description: String
    public var risk: String?
    public var cohesion: String?
    /// For an outlier, what to ask the author.
    public var question: String
    public var files: [ChangeTheme.File]
}

/// Starts with a NUL so no theme key (`<index>:<title>`) can equal it.
public let storyLeftoversKey = "\u{0}unmapped"

public func storyChapters(_ map: VerificationChangeMap) -> [StoryChapter] {
    var chapters = map.themes.enumerated().map { i, t in
        StoryChapter(id: "\(i):\(t.title)", title: t.title, description: t.description, risk: t.risk,
                     cohesion: t.cohesion, question: t.question, files: t.files)
    }
    if !map.unmapped.isEmpty {
        chapters.append(StoryChapter(
            id: storyLeftoversKey, title: "Everything else",
            description: "Changed files the change map didn't put in a theme.", risk: nil, cohesion: nil,
            question: "", files: map.unmapped.map { ChangeTheme.File(path: $0, lines: nil) }))
    }
    return chapters
}

/// A chapter is read once every file in it is marked viewed.
public func chapterRead(_ chapter: StoryChapter, viewed: Set<String>) -> Bool {
    chapter.files.allSatisfy { viewed.contains($0.path) }
}

/// One row of a unified patch, with both files' line numbers.
public struct PatchRow: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        case hunk, add, del, context, meta
    }

    public var kind: Kind
    /// The line as the patch has it, marker column included.
    public var text: String
    /// The head file's line for add and context rows.
    public var rightLine: Int?
    /// The base file's line for del and context rows.
    public var leftLine: Int?

    public init(_ kind: Kind, _ text: String, right: Int? = nil, left: Int? = nil) {
        self.kind = kind
        self.text = text
        rightLine = right
        leftLine = left
    }

    /// The line without its `+`, `-` or space marker.
    public var body: String {
        guard kind == .add || kind == .del || kind == .context, let first = text.first,
              first == "+" || first == "-" || first == " " else { return text }
        return String(text.dropFirst())
    }
}

private func firstNumber(after marker: Character, in text: String) -> Int? {
    guard let at = text.firstIndex(of: marker) else { return nil }
    let digits = text[text.index(after: at)...].prefix(while: \.isNumber)
    return Int(digits)
}

/// Parses a unified patch into rows. A raw `git diff` starts each file with
/// a header block (`diff --git`, `index`, `---`/`+++`) up to the first hunk;
/// it carries no source lines, so it is skipped rather than counted.
public func patchRows(_ patch: String) -> [PatchRow] {
    var rows: [PatchRow] = []
    var right = 0
    var left = 0
    var inFileHeader = false
    for text in patch.components(separatedBy: "\n") {
        if text.hasPrefix("diff --git") {
            inFileHeader = true
            continue
        }
        if text.hasPrefix("@@") {
            inFileHeader = false
            // `@@ -a,b +c,d @@`: a and c are the hunk's first base and head lines.
            right = firstNumber(after: "+", in: text) ?? 0
            left = firstNumber(after: "-", in: text) ?? 0
            rows.append(PatchRow(.hunk, text))
            continue
        }
        if inFileHeader { continue }
        if text.hasPrefix("\\") {
            rows.append(PatchRow(.meta, text))
        } else if text.hasPrefix("+") {
            rows.append(PatchRow(.add, text, right: right))
            right += 1
        } else if text.hasPrefix("-") {
            rows.append(PatchRow(.del, text, left: left))
            left += 1
        } else {
            rows.append(PatchRow(.context, text, right: right, left: left))
            right += 1
            left += 1
        }
    }
    return rows
}

/// The hunks of a file's patch that touch `lines` on the head side, each with
/// its header row; the whole patch when there is no range. A hunk that only
/// removes lines is kept when it sits at a line inside the range, since a
/// removal is part of the theme too.
public func rowsInRange(_ rows: [PatchRow], lines: LineRange?) -> [PatchRow] {
    let shown = rows.filter { $0.kind != .meta }
    guard let lines else { return shown }
    let inRange = { (n: Int) in n >= lines.start && n <= lines.end }
    var kept: [PatchRow] = []
    var hunk: [PatchRow] = []
    func flush() {
        guard !hunk.isEmpty else { return }
        let heads = hunk.compactMap(\.rightLine)
        let start = hunk[0].kind == .hunk ? firstNumber(after: "+", in: hunk[0].text) : nil
        let touches = heads.isEmpty ? start.map(inRange) ?? false : heads.contains(where: inRange)
        if touches { kept += hunk }
        hunk = []
    }
    for row in shown {
        if row.kind == .hunk { flush() }
        hunk.append(row)
    }
    flush()
    return kept
}

/// Rows a chapter shows per file before the rest is left to the diff tab.
public let storyMaxRows = 400
/// Files a chapter shows before "Show N more files".
public let storyFilesShown = 5

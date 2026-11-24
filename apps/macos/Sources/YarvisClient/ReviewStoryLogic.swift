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

/// Where a hunk starts on the head side, from its `@@ -a,b +c,d @@` header.
private func headStart(_ header: String) -> Int? {
    guard let at = header.firstIndex(of: "+") else { return nil }
    return Int(header[header.index(after: at)...].prefix(while: \.isNumber))
}

/// The hunks of a file's parsed patch (`parseUnifiedDiff`) that touch
/// `lines` on the head side, each with its header row; the whole patch when
/// there is no range. A hunk that only removes lines is kept when it sits at
/// a line inside the range, since a removal is part of the theme too.
public func rowsInRange(_ rows: [DiffLine], lines: LineRange?) -> [DiffLine] {
    let shown = rows.filter { $0.kind != .meta }
    guard let lines else { return shown }
    let inRange = { (n: Int) in n >= lines.start && n <= lines.end }
    var kept: [DiffLine] = []
    var hunk: [DiffLine] = []
    func flush() {
        guard !hunk.isEmpty else { return }
        let heads = hunk.compactMap(\.newLine)
        let start = hunk[0].kind == .hunk ? headStart(hunk[0].text) : nil
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

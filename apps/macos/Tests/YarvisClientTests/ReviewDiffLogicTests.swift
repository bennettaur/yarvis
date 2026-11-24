import Foundation
import Testing
@testable import YarvisClient

/// Applies a diff's edits back onto `old` to check they rebuild `new`.
private func rebuild(_ edits: [LineEdit], old: [String], new: [String]) -> [String] {
    edits.compactMap { edit in
        switch edit {
        case .equal(let o, let n):
            #expect(old[o] == new[n])
            return new[n]
        case .insert(let n): return new[n]
        case .delete: return nil
        }
    }
}

private func lines(_ s: String) -> [String] { s.map(String.init) }

@Suite struct ReviewDiffLogicTests {
    @Test func splitsFileLines() {
        #expect(splitFileLines("") == [])
        #expect(splitFileLines("a\nb\n") == ["a", "b"])
        #expect(splitFileLines("a\r\nb") == ["a", "b"])
        #expect(splitFileLines("a\n\n") == ["a", ""])
    }

    @Test func diffRebuildsTheNewFile() {
        let cases = [("abcabba", "cbabac"), ("", "abc"), ("abc", ""), ("abc", "abc"), ("axbyc", "abc"), ("ab", "ba")]
        for (a, b) in cases {
            let old = lines(a), new = lines(b)
            let edits = lineDiff(old: old, new: new)
            #expect(rebuild(edits, old: old, new: new) == new)
            #expect(edits.compactMap { if case .delete(let o) = $0 { return o } else { return nil } }.count
                + edits.filter { if case .equal = $0 { return true } else { return false } }.count == old.count)
        }
    }

    @Test func diffIsShortest() {
        // Myers' classic example: 5 edits.
        let edits = lineDiff(old: lines("abcabba"), new: lines("cbabac"))
        #expect(edits.filter { if case .equal = $0 { return false } else { return true } }.count == 5)
    }

    @Test func changedRunListsDeletionsBeforeInsertions() {
        let edits = lineDiff(old: ["a", "x", "y", "b"], new: ["a", "p", "q", "b"])
        #expect(edits == [.equal(old: 0, new: 0), .delete(old: 1), .delete(old: 2), .insert(new: 1),
                          .insert(new: 2), .equal(old: 3, new: 3)])
    }

    @Test func tooManyEditsFallsBackToReplace() {
        let edits = lineDiff(old: ["s", "a", "b", "e"], new: ["s", "c", "d", "e"], maxEdits: 1)
        #expect(edits == [.equal(old: 0, new: 0), .delete(old: 1), .delete(old: 2), .insert(new: 1),
                          .insert(new: 2), .equal(old: 3, new: 3)])
    }

    @Test func bigFileDiffsQuickly() {
        let old = (0..<5_000).map { "line \($0)" }
        var new = old
        for i in stride(from: 4_990, to: 0, by: -10) { new[i] = "changed \(i)" }
        new.insert(contentsOf: (0..<50).map { "added \($0)" }, at: 2_500)
        let start = Date()
        let edits = lineDiff(old: old, new: new)
        #expect(Date().timeIntervalSince(start) < 2)
        #expect(rebuild(edits, old: old, new: new) == new)
        let changed = edits.filter { if case .equal = $0 { return false } else { return true } }.count
        #expect(changed == 499 * 2 + 50)
    }

    @Test func pairsUnifiedAndSplit() {
        let edits = lineDiff(old: ["a", "x", "y", "b"], new: ["a", "p", "b"])
        #expect(diffPairs(edits, layout: .unified) == [
            DiffPair(old: 1, new: 1, changed: false),
            DiffPair(old: 2, new: nil, changed: true),
            DiffPair(old: 3, new: nil, changed: true),
            DiffPair(old: nil, new: 2, changed: true),
            DiffPair(old: 4, new: 3, changed: false),
        ])
        #expect(diffPairs(edits, layout: .split) == [
            DiffPair(old: 1, new: 1, changed: false),
            DiffPair(old: 2, new: 2, changed: true),
            DiffPair(old: 3, new: nil, changed: true),
            DiffPair(old: 4, new: 3, changed: false),
        ])
    }

    private func pairs(_ changed: Set<Int>, count: Int) -> [DiffPair] {
        (0..<count).map { DiffPair(old: $0 + 1, new: $0 + 1, changed: changed.contains($0)) }
    }

    @Test func foldsKeepThreeLinesOfContext() {
        let rows = foldedRows(pairs([10], count: 20))
        #expect(rows == [.fold(id: 0, hidden: 7)] + (7...13).map { .pair($0) } + [.fold(id: 14, hidden: 6)])
    }

    @Test func shortStretchesStayOpen() {
        // Two lines between the contexts aren't worth a fold.
        let rows = foldedRows(pairs([0, 9], count: 10))
        #expect(rows == (0...9).map { .pair($0) })
    }

    @Test func keptLinesStayVisible() {
        let rows = foldedRows(pairs([], count: 20), keep: [10])
        #expect(rows == [.fold(id: 0, hidden: 7)] + (7...13).map { .pair($0) } + [.fold(id: 14, hidden: 6)])
    }

    @Test func revealsOpenFromEitherEnd() {
        let all = pairs([], count: 50)
        #expect(foldedRows(all) == [.fold(id: 0, hidden: 50)])
        #expect(foldedRows(all, reveals: [0: FoldReveal(top: 20)]) == (0..<20).map { .pair($0) } + [.fold(id: 0, hidden: 30)])
        #expect(foldedRows(all, reveals: [0: FoldReveal(top: 20, bottom: 20)])
            == (0..<20).map { .pair($0) } + [.fold(id: 0, hidden: 10)] + (30..<50).map { .pair($0) })
        #expect(foldedRows(all, reveals: [0: .all]) == (0..<50).map { .pair($0) })
    }

    @Test func columnsExpandTabs() {
        #expect(displayColumns("ab") == 2)
        #expect(displayColumns("\tx") == 5)
        #expect(displayColumns("ab\tx") == 5)
        #expect(displayColumns("😀") == 2)
        #expect(utf16Offset(atColumn: 0, in: "\tx") == 0)
        #expect(utf16Offset(atColumn: 3, in: "\tx") == 0)
        #expect(utf16Offset(atColumn: 4, in: "\tx") == 1)
        #expect(utf16Offset(atColumn: 9, in: "\tx") == 2)
        #expect(wrappedRows(columns: 0, perRow: 80) == 1)
        #expect(wrappedRows(columns: 161, perRow: 80) == 3)
    }

    @Test func identifierUnderClick() {
        let line = "let total = sum(items) + valid?"
        #expect(identifier(in: line, at: 6) == "total")
        #expect(identifier(in: line, at: 4) == "total")
        #expect(identifier(in: line, at: 3) == nil)
        #expect(identifier(in: line, at: 26) == "valid?")
        #expect(identifier(in: line, at: 30) == "valid?")
        #expect(identifier(in: "x = 42", at: 4) == nil)
        #expect(identifier(in: "$el.on", at: 1) == "$el")
        #expect(identifier(in: "", at: 0) == nil)
    }

    @Test func navigationOpensDiffFileOrNothing() {
        let changed: Set<String> = ["a.ts"]
        let tree: Set<String> = ["a.ts", "b.ts"]
        #expect(navigationTab(prId: "p", path: "a.ts", line: 3, changed: changed, tree: tree)
            == .diff(prId: "p", path: "a.ts", revealLine: 3))
        #expect(navigationTab(prId: "p", path: "b.ts", line: 9, changed: changed, tree: tree)
            == .file(prId: "p", path: "b.ts", revealLine: 9))
        #expect(navigationTab(prId: "p", path: "../etc", line: 1, changed: changed, tree: tree) == nil)
    }

    @Test func wideAndCombiningCharactersCountTheirWidth() {
        #expect(displayColumns("日本") == 4)
        #expect(displayColumns("한글") == 4)
        #expect(displayColumns("ｘ") == 2)
        #expect(displayColumns("e\u{301}") == 1)
        #expect(displayColumns("👍🏽") == 4)
        #expect(displayColumns("a\u{200B}b") == 2)
        #expect(displayColumns("❤\u{FE0F}") == 1)
        // A click on the second column of a wide character lands on it.
        #expect(utf16Offset(atColumn: 1, in: "日本") == 0)
        #expect(utf16Offset(atColumn: 2, in: "日本") == 1)
        // Emoji are two UTF-16 units.
        #expect(utf16Offset(atColumn: 2, in: "😀x") == 2)
    }

    @Test func lineBreaksInsideALineAreDrawnAsMarks() {
        #expect(drawableLine("plain") == "plain")
        #expect(drawableLine("a\rb\u{2028}c\u{0085}d") == "a\u{240D}b\u{2424}c\u{2424}d")
        #expect(drawableLine("a\u{2028}b").utf16.count == "a\u{2028}b".utf16.count)
    }

    @Test func explainsChangesNoLineShows() {
        #expect(invisibleChangeNote(old: "a\n", new: "a\n") == nil)
        #expect(invisibleChangeNote(old: "a\r\nb\r\n", new: "a\nb\n") == "Line endings changed.")
        #expect(invisibleChangeNote(old: "a\nb\n", new: "a\nb") == "No newline at end of file.")
        #expect(invisibleChangeNote(old: "a", new: "a\n") == "Newline added at end of file.")
        #expect(invisibleChangeNote(old: "é", new: "e\u{301}") != nil)
    }

    @Test func highlightsTheMustReadRangeAndEachCitedLine() {
        let mustRead = VerificationMustRead(path: "src/cache.ts", reason: "Eviction logic",
                                            lines: LineRange(start: 10, end: 12))
        let notes = [
            FileNote(source: "Performance", title: "N+1", detail: "One query per user", severity: "high", line: 9),
            FileNote(source: "Risk", title: "Races", line: 11),
        ]
        let marks = reviewLineMarks(mustRead: mustRead, notes: notes)
        #expect(marks.keys.sorted() == [9, 10, 11, 12])
        #expect(marks[10] == ReviewLineMark(mustRead: true, hover: "Must read: Eviction logic"))
        #expect(marks[9] == ReviewLineMark(cited: true, hover: "Performance (high): N+1. One query per user"))
        #expect(marks[11] == ReviewLineMark(mustRead: true, cited: true, hover: "Must read: Eviction logic\nRisk: Races"))
    }

    @Test func noRangeForAMustReadWithoutLines() {
        let mustRead = VerificationMustRead(path: "a.ts", reason: "why")
        #expect(reviewLineMarks(mustRead: mustRead, notes: []).isEmpty)
    }

    @Test func findsEveryMatchIgnoringCase() {
        let matches = findMatches("ab", in: ["xAbab", "none", "AB"])
        #expect(matches == [LineMatch(line: 1, start: 1, length: 2), LineMatch(line: 1, start: 3, length: 2),
                            LineMatch(line: 3, start: 0, length: 2)])
        #expect(findMatches("", in: ["a"]).isEmpty)
        #expect(findMatches("a", in: ["aaaa"], limit: 2).count == 2)
        #expect(findMatches("x", in: ["日x"]) == [LineMatch(line: 1, start: 1, length: 1)])
    }
}

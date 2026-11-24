import Foundation
import Testing
@testable import YarvisClient

private let map = VerificationChangeMap(
    intent: "Cache lookups",
    themes: [
        ChangeTheme(title: "Cache", description: "d", risk: "high", cohesion: "core", question: "",
                    files: [.init(path: "a.ts", lines: LineRange(start: 1, end: 9)), .init(path: "b.ts", lines: nil)]),
        ChangeTheme(title: "Logo", description: "", risk: "low", cohesion: "outlier", question: "Why?",
                    files: [.init(path: "logo.svg", lines: nil)]),
    ],
    unmapped: ["README.md"])

private let patch = [
    "diff --git a/f.ts b/f.ts",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    "@@ -20,2 +19,0 @@",
    "-gone",
    "-also gone",
    "@@ -40,2 +38,3 @@",
    " forty",
    "+added",
    " forty-one",
].joined(separator: "\n")

@Suite struct ReviewStoryLogicTests {
    @Test func followsTheChangeMapAndClosesWithTheFilesNoThemeNames() {
        let chapters = storyChapters(map)
        #expect(chapters.map(\.id) == ["0:Cache", "1:Logo", storyLeftoversKey])
        #expect(chapters[2].title == "Everything else")
        #expect(chapters[2].files.map(\.path) == ["README.md"])
        #expect(chapters[1].question == "Why?")
    }

    @Test func countsAChapterReadOnceEveryFileIsViewed() {
        let cache = storyChapters(map)[0]
        #expect(!chapterRead(cache, viewed: ["a.ts"]))
        #expect(chapterRead(cache, viewed: ["a.ts", "b.ts"]))
    }

    @Test func parsesLineNumbersAndSkipsGitsHeader() {
        let rows = patchRows(patch)
        #expect(rows.first?.text == "@@ -1,3 +1,3 @@")
        #expect(rows[1] == PatchRow(.context, " one", right: 1, left: 1))
        #expect(rows[2] == PatchRow(.del, "-two", left: 2))
        #expect(rows[3] == PatchRow(.add, "+TWO", right: 2))
        #expect(rows.last == PatchRow(.context, " forty-one", right: 40, left: 41))
        #expect(rows[3].body == "TWO")
    }

    @Test func treatsNoNewlineMarkersAsMetadata() {
        let rows = patchRows("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b")
        #expect(rows.map(\.kind) == [.hunk, .del, .meta, .add])
        #expect(rows[3].rightLine == 1)
        #expect(rowsInRange(rows, lines: nil).map(\.kind) == [.hunk, .del, .add])
    }

    @Test func showsTheWholePatchWithoutARange() {
        let rows = patchRows(patch)
        #expect(rowsInRange(rows, lines: nil) == rows)
    }

    @Test func keepsOnlyTheHunksThatTouchTheRangeARemovalByWhereItWas() {
        let rows = patchRows(patch)
        #expect(rowsInRange(rows, lines: LineRange(start: 38, end: 40)).map(\.text)
            == ["@@ -40,2 +38,3 @@", " forty", "+added", " forty-one"])
        #expect(rowsInRange(rows, lines: LineRange(start: 19, end: 21)).map(\.text)
            == ["@@ -20,2 +19,0 @@", "-gone", "-also gone"])
        #expect(rowsInRange(rows, lines: LineRange(start: 100, end: 120)).isEmpty)
    }
}

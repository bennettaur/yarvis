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

    @Test func showsTheWholePatchWithoutGitsHeaderOrMetaWithoutARange() {
        let rows = parseUnifiedDiff(patch + "\n\\ No newline at end of file")
        let shown = rowsInRange(rows, lines: nil)
        #expect(shown.first?.text == "@@ -1,3 +1,3 @@")
        #expect(!shown.contains { $0.kind == .meta })
        #expect(shown.count == rows.count - 1)
    }

    @Test func keepsOnlyTheHunksThatTouchTheRangeARemovalByWhereItWas() {
        let rows = parseUnifiedDiff(patch)
        #expect(rowsInRange(rows, lines: LineRange(start: 38, end: 40)).map(\.text)
            == ["@@ -40,2 +38,3 @@", "forty", "added", "forty-one"])
        #expect(rowsInRange(rows, lines: LineRange(start: 19, end: 21)).map(\.text)
            == ["@@ -20,2 +19,0 @@", "gone", "also gone"])
        #expect(rowsInRange(rows, lines: LineRange(start: 100, end: 120)).isEmpty)
    }
}

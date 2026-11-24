import Testing
@testable import YarvisClient

private func thread(_ id: String, path: String? = "a.ts", line: Int? = 5, side: DiffSide = .right,
                    resolved: Bool = false, outdated: Bool = false, bodies: [String] = ["hi"]) -> PrThread {
    PrThread(id: id, path: path, line: line, side: side, isResolved: resolved, isOutdated: outdated,
             comments: bodies.enumerated().map { PrComment(id: "\(id)-\($0.offset)", author: "sam", body: $0.element, createdAt: "") })
}

private func insight(_ id: String, path: String = "a.ts", end: Int, sha: String = "h1") -> PrInsight {
    PrInsight(id: id, path: path, startLine: end, endLine: end, headSha: sha, question: "q", answer: "a",
              postedAt: nil, createdAt: "", placement: nil)
}

@Suite struct ReviewCommentLogicTests {
    @Test func describesLines() {
        #expect(describeLines(line: 4, side: .right) == "line 4")
        #expect(describeLines(line: 9, side: .right, startLine: 4) == "lines 4–9")
        #expect(describeLines(line: 3, side: .left) == "line 3 (old)")
        #expect(describeLines(line: 9, side: .left, startLine: 4) == "lines 4–9 (old)")
        #expect(describeLines(line: 9, side: .right, startLine: 3, startSide: .left) == "old line 3 to new line 9")
        #expect(describeLines(line: 4, side: .right, startLine: 4) == "line 4")
        #expect(!needsLineLabel(side: .right, startLine: nil))
        #expect(needsLineLabel(side: .left, startLine: nil))
        #expect(needsLineLabel(side: .right, startLine: 2))
    }

    @Test func extendsTheComposer() {
        let at5 = CommentTarget(side: .right, line: 5)
        #expect(extendTarget(at5, to: 9) == CommentTarget(side: .right, line: 9, startLine: 5))
        #expect(extendTarget(at5, to: 2) == CommentTarget(side: .right, line: 5, startLine: 2))
        #expect(extendTarget(at5, to: 5) == at5)
        let range = CommentTarget(side: .right, line: 9, startLine: 5)
        #expect(extendTarget(range, to: 7) == range)
        #expect(extendTarget(range, to: 12) == CommentTarget(side: .right, line: 12, startLine: 5))
    }

    @Test func providerLinksOnlyForProviderHosts() {
        #expect(threadProviderName("https://github.com/o/r/pull/1#x") == "GitHub")
        #expect(threadProviderName("https://api.github.com/x") == "GitHub")
        #expect(threadProviderName("https://dev.azure.com/o/p") == "Azure DevOps")
        #expect(threadProviderName("https://acme.visualstudio.com/p") == "Azure DevOps")
        #expect(threadProviderName("https://github.com.evil.example/x") == nil)
        #expect(threadProviderName("javascript:alert(1)") == nil)
        #expect(threadProviderName("not a url") == nil)
    }

    @Test func comparesBodiesLikeTheProvider() {
        #expect(comparableBody("  a\r\nb \n") == "a\nb")
    }

    @Test func replyPendingUntilALaterCommentMatches() {
        let reply = PostedReply(id: 0, threadId: "t", body: "+1", afterCount: 1)
        // An earlier "+1" doesn't count.
        #expect(replyIsPending(reply, threads: ["t": thread("t", bodies: ["+1"])]))
        #expect(!replyIsPending(reply, threads: ["t": thread("t", bodies: ["+1", "+1\r\n"])]))
        #expect(replyIsPending(reply, threads: [:]))
    }

    @Test func overridesStayUntilTheServerAgrees() {
        let threads = ["a": thread("a", resolved: true), "b": thread("b", resolved: false)]
        #expect(pendingOverrides(["a": true, "b": true, "c": false], threads: threads) == ["b": true, "c": false])
    }

    @Test func pendingCommentsClearWhenTheirLineCarriesThem() {
        let posted = [
            PostedLineComment(id: 0, target: CommentTarget(side: .right, line: 5), body: "nice"),
            PostedLineComment(id: 1, target: CommentTarget(side: .left, line: 5), body: "nice"),
        ]
        let pending = pendingLineComments(posted, threads: [thread("t", line: 5, bodies: ["nice\n"])])
        #expect(pending.map(\.id) == [1])
    }

    @Test func splitsInlineFromOutdated() {
        let threads = [thread("a"), thread("b", outdated: true), thread("c", line: nil), thread("d", path: "b.ts")]
        let split = splitThreads(threads, path: "a.ts")
        #expect(split.inline.map(\.id) == ["a"])
        #expect(split.outdated.map(\.id) == ["b", "c"])
    }

    @Test func anchorsAreUniqueAndOrdered() {
        let anchors = commentAnchors(
            threads: [thread("a", line: 9), thread("b", line: 3, side: .right), thread("c", line: 9)],
            pending: [ZoneAnchor(side: .left, line: 3)], composer: ZoneAnchor(side: .right, line: 1))
        #expect(anchors == [ZoneAnchor(side: .right, line: 1), ZoneAnchor(side: .left, line: 3),
                            ZoneAnchor(side: .right, line: 3), ZoneAnchor(side: .right, line: 9)])
    }

    @Test func insightsHangUnderTheirEndLine() {
        let list = [insight("1", end: 8), insight("2", end: 3), insight("3", end: 8)]
        #expect(insightLines(list, asking: 5) == [3, 5, 8])
        #expect(insightLines([], asking: nil) == [])
        #expect(insightsAtLine(list, line: 8).map(\.id) == ["1", "3"])
        #expect(insightsByPath(list + [insight("4", path: "b.ts", end: 1)])["b.ts"]?.map(\.id) == ["4"])
        #expect(insightIsStale(insight("x", end: 1, sha: "old"), currentSha: "new"))
        #expect(!insightIsStale(insight("x", end: 1, sha: "old"), currentSha: ""))
    }

    @Test func linesTextIsInclusive() {
        let content = "one\ntwo\nthree\nfour"
        #expect(linesText(content, start: 2, end: 3) == "two\nthree")
        #expect(linesText(content, start: 4, end: 4) == "four")
        #expect(linesText(content, start: 3, end: 1) == "three")
        #expect(linesText(content, start: 9, end: 10) == "")
        // As shown: a CRLF file's lines go without their "\r".
        #expect(linesText("a\r\nb\r\nc", start: 1, end: 2) == "a\nb")
        #expect(linesText("a\nb\n", start: 2, end: 3) == "b")
    }

    @Test func outdatedLabel() {
        #expect(outdatedThreadsLabel([thread("a")]) == "1 outdated thread")
        #expect(outdatedThreadsLabel([thread("a"), thread("b")]) == "2 outdated threads")
    }
}

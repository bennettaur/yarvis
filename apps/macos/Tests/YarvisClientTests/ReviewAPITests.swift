import Foundation
import Testing
@testable import YarvisClient

private let reviewBase = URL(string: "https://yarvis.test")!
private let gh = PrRef.github(owner: "o", repo: "api", number: 12)
private let az = PrRef.azure(org: "acme", project: "Proj X", repo: "web", prId: 7)
private let sha = String(repeating: "a", count: 40)

private func client(_ status: Int = 200, _ body: String = "{}") -> (YarvisClient, String) {
    let (session, id) = StubProtocol.session { _, _ in (status, json(body)) }
    return (YarvisClient(baseURL: reviewBase, token: "tok", session: session), id)
}

private func only(_ id: String) throws -> (URLRequest, JSONValue?) {
    let (req, body) = try #require(StubProtocol.recorded(id).last)
    return (req, bodyJSON(body))
}

private func path(_ req: URLRequest) -> String {
    String((req.url?.absoluteString ?? "").dropFirst(reviewBase.absoluteString.count))
}

private let prJSON = #"""
{"id":"p1","workspaceId":"w1","refKey":"gh:o/api/12",
 "ref":{"provider":"github","owner":"o","repo":"api","number":12},
 "title":"Add thing","author":"sam","headRef":"feat","baseRef":"main","colorIndex":2,"position":0,
 "status":"ready","error":null,"worktreePath":"/r/p1","worktreeStatus":"ready","headSha":"h","baseSha":"b",
 "mergeBaseSha":"m","setupConsent":null,"setupStatus":null,"setupLog":null,"addedAt":"2026-11-01T00:00:00Z"}
"""#

private let workspaceJSON = #"""
{"id":"w1","name":"Review","status":"active","error":null,"createdAt":"c","updatedAt":"u","lastOpenedAt":null,
 "askClaudeRepoConfig":false,"prs":[\#(prJSON)]}
"""#

@Suite struct ReviewDecodingTests {
    @Test func aWorkspaceReadsItsPrsAndTheirRefs() throws {
        let ws = try JSONDecoder().decode(ReviewWorkspace.self, from: json(workspaceJSON))
        let pr = try #require(ws.prs.first)
        #expect(pr.ref == gh)
        #expect(pr.ref.key == pr.refKey)
        #expect(pr.checkoutReady)
        #expect(pr.setupHeadSha == nil)
    }

    @Test func refsRoundTripAndKeyLikeTheSidecar() throws {
        for ref in [gh, az] {
            let back = try JSONDecoder().decode(PrRef.self, from: JSONEncoder().encode(ref))
            #expect(back == ref)
        }
        #expect(az.key == "az:acme/Proj X/web/7")
        #expect(prLabel(az) == "web#7")
        #expect(az.webURL?.absoluteString == "https://dev.azure.com/acme/Proj%20X/_git/web/pullrequest/7")
    }

    @Test func anUnknownProviderIsRefused() {
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(PrRef.self, from: json(#"{"provider":"gitlab","repo":"x"}"#))
        }
    }

    @Test func aDetailToleratesMissingOptionalFields() throws {
        let d = try JSONDecoder().decode(PrDetail.self, from: json(#"""
        {"number":12,"title":"t","body":"","state":"OPEN","draft":false,"author":"a","baseRef":"main","headRef":"f",
         "fromFork":false,"headSha":"h","additions":1,"deletions":2,"mergeable":"MERGEABLE","hasConflicts":false,
         "mergeMethods":["SQUASH"],"autoMergeEnabled":false,"canEnableAutoMerge":true,"canDisableAutoMerge":false,
         "checks":[{"name":"ci","status":"COMPLETED","conclusion":"SUCCESS","url":null}],
         "reviewThreads":[{"id":"t1","path":"a.ts","line":4,"side":"LEFT","isResolved":false,"isOutdated":false,
           "canReply":true,"canResolve":true,"canUnresolve":false,
           "comments":[{"id":"c1","author":"a","body":"hm","createdAt":"x"}]}],
         "reviewers":[{"login":"r","state":"changes_requested","isRequested":false}],"viewerReview":"approved"}
        """#))
        #expect(d.mergeMethods == [.squash])
        #expect(d.reviewThreads.first?.side == .left)
        #expect(d.reviewers.first?.state == .changesRequested)
        #expect(d.conversation == nil)
    }

    @Test func aChecklistReadsUnknownCoverageAndMissingMustRead() throws {
        let c = try JSONDecoder().decode(VerificationChecklist.self, from: json(#"""
        {"headSha":"h","themes":[{"id":"understand","label":"Understand"}],
         "items":[{"section":"summary","theme":"understand","label":"Summary","description":"d",
                   "latest":{"id":"r1","status":"running","live":true,"headSha":"h","current":true,"error":null,
                             "costUsd":null,"startedAt":"s","finishedAt":null},"result":null}],
         "report":{"summary":"ok","coverage":{"unknown":true},
                   "malice":{"status":"issues","findings":[{"title":"t","detail":"d","severity":"high"}],
                             "tripwires":[{"kind":"build","path":"x.sh","note":"n"}]}},
         "size":null,"namedTickets":[]}
        """#))
        let report = try #require(c.report)
        #expect(report.mustRead == nil)
        #expect(report.coverage?.isKnown == false)
        #expect(report.check("malice")?.findings.count == 1)
        #expect(c.items.first?.latest?.live == true)
    }

    @Test func progressEventsDecodeByType() throws {
        #expect(try ReviewProgressEvent.decode(json(#"{"type":"log","text":"Cloning"}"#)) == .log("Cloning"))
        #expect(try ReviewProgressEvent.decode(json(#"{"type":"done","phase":"setup","status":"failed","error":"x"}"#))
            == .done(phase: "setup", status: "failed", error: "x"))
        #expect(try AgentRunEvent.decode(json(#"{"type":"tool","id":"1","name":"Read","summary":"a.ts","subagentId":null}"#))
            == .tool(id: "1", name: "Read", summary: "a.ts", subagentId: nil))
        #expect(throws: (any Error).self) { try AgentRunEvent.decode(json(#"{"type":"ping"}"#)) }
    }

    @Test func mutationEventsCarryResultsAndNestedAgentEvents() throws {
        let mutant = try MutationProgressEvent.decode(json(#"""
        {"type":"mutant","index":0,"total":3,"control":false,
         "result":{"id":"m1","path":"a.ts","line":3,"oldText":"<","newText":"<=","description":"d","rationale":"r",
                   "testCommandId":null,"testFiles":[],"outcome":"survived","durationMs":null,"testCount":null,
                   "evidence":""}}
        """#))
        guard case .mutant(let result, _, let total, let control) = mutant else {
            Issue.record("not a mutant")
            return
        }
        #expect(result.outcome == "survived" && total == 3 && !control)
        #expect(try MutationProgressEvent.decode(json(#"{"type":"agent","phase":"planning","event":{"type":"status","message":"go"}}"#))
            == .agent(phase: "planning", event: .status("go")))
    }
}

@Suite struct ReviewRequestTests {
    @Test func creatingAWorkspaceSendsItsRefs() async throws {
        let (c, id) = client(200, workspaceJSON)
        _ = try await c.createReviewWorkspace(name: "Review", refs: [az])
        let (req, body) = try only(id)
        #expect(req.httpMethod == "POST")
        #expect(path(req) == "/api/sidecar/api/review-workspaces")
        #expect(body?["refs"] == .array([az.json]))
        #expect(body?["refs"]?.arrayFirst?["prId"] == .number(7))
    }

    @Test func fileAndSymbolReadsEncodeTheirQueries() async throws {
        let (c, id) = client(200, #"{"headSha":"h","matches":[],"truncated":false}"#)
        _ = try await c.reviewSymbolSearch(workspaceId: "w1", prId: "p1", kind: .references, path: "src/a b.ts",
                                           symbol: "go", line: 4)
        #expect(path(try only(id).0) == "/api/sidecar/api/review-workspaces/w1/prs/p1/references?path=src%2Fa%20b%2Ets&symbol=go&line=4")
    }

    @Test func aSetupAnswerSendsWhatThePromptShowed() async throws {
        let (c, id) = client(200, prJSON)
        _ = try await c.answerReviewSetup(workspaceId: "w1", prId: "p1", grant: true, script: nil, headSha: sha)
        let (_, body) = try only(id)
        #expect(body == .object(["grant": .bool(true), "script": .null, "headSha": .string(sha)]))
    }

    @Test func aCommentSendsOnlyFullShasAndTheLeftSide() async throws {
        let (c, id) = client(200, #"{"ok":true,"placement":"file"}"#)
        let right = try await c.postPrComment(gh, NewPrComment(path: "a.ts", line: 9, body: "b", startLine: 4),
                                              seen: SeenCommits(headSha: sha, mergeBaseSha: "short"))
        #expect(right.placement == .file)
        var (req, body) = try only(id)
        #expect(path(req) == "/api/sidecar/api/github/pr/o/api/12/comments")
        #expect(body == .object(["path": .string("a.ts"), "line": .number(9), "body": .string("b"),
                                 "startLine": .number(4), "headSha": .string(sha)]))
        _ = try await c.postPrComment(gh, NewPrComment(path: "a.ts", line: 2, body: "b", side: .left), seen: .init())
        (req, body) = try only(id)
        #expect(body?["side"] == .string("LEFT"))
    }

    @Test func reviewVerdictsUseEachProvidersVocabulary() async throws {
        let (c, id) = client(200, #"{"ok":true}"#)
        try await c.applyReviewAction(gh, .requestChanges, body: "fix", seen: SeenCommits(headSha: sha))
        var (req, body) = try only(id)
        #expect(path(req) == "/api/sidecar/api/github/pr/o/api/12/reviews")
        #expect(body?["event"] == .string("REQUEST_CHANGES") && body?["headSha"] == .string(sha))
        try await c.applyReviewAction(az, .approve)
        (req, body) = try only(id)
        #expect(path(req) == "/api/sidecar/api/azure/pr/Proj%20X/web/7/vote")
        #expect(body == .object(["vote": .number(10)]))
        try await c.applyReviewAction(az, .publish)
        #expect(path(try only(id).0) == "/api/sidecar/api/azure/pr/Proj%20X/web/7/ready")
    }

    @Test func aMergeIsPinnedToTheReviewedHead() async throws {
        let (c, id) = client(200, #"{"ok":true}"#)
        try await c.mergePr(gh, method: .squash, headSha: sha)
        var (req, body) = try only(id)
        #expect(path(req) == "/api/sidecar/api/github/pr/o/api/12/merge")
        #expect(body == .object(["method": .string("SQUASH"), "headSha": .string(sha)]))
        try await c.enableAutoMerge(gh, method: .merge, headSha: "short")
        (req, body) = try only(id)
        #expect(path(req) == "/api/sidecar/api/github/pr/o/api/12/auto-merge")
        #expect(body == .object(["method": .string("MERGE")]))
    }

    @Test func anAzureReplyNamesANumericParent() async throws {
        let (c, id) = client(200, #"{"ok":true}"#)
        let thread = PrThread(id: "9", path: nil, line: nil, comments: [PrComment(id: "3", author: "a", body: "b", createdAt: "")])
        try await c.replyToPrThread(az, thread, body: "yes")
        #expect(try only(id).1 == .object(["body": .string("yes"), "parentCommentId": .number(3)]))
        try await c.replyToPrThread(gh, thread, body: "yes")
        #expect(try only(id).1 == .object(["body": .string("yes")]))
    }

    @Test func verificationSendsOnlyTheChoicesMade() async throws {
        let (c, id) = client(200, #"{"runs":[],"failed":[{"section":"flow","error":"busy"}]}"#)
        let started = try await c.startVerification(workspaceId: "w1", prId: "p1", sections: ["summary"])
        #expect(started.failed.first?.error == "busy")
        #expect(try only(id).1 == .object(["sections": .array([.string("summary")])]))
        _ = try await c.startVerification(workspaceId: "w1", prId: "p1", sections: ["risk"], namedTickets: ["ABC-1"],
                                          choice: VerificationRunChoice(effort: "high"), harness: "h1")
        #expect(try only(id).1 == .object([
            "sections": .array([.string("risk")]), "namedTickets": .array([.string("ABC-1")]),
            "override": .object(["effort": .string("high")]), "harness": .string("h1"),
        ]))
    }

    @Test func anAzureSummaryAsksWithItsOrgAndReadsItsStatus() async throws {
        let (c, id) = client(200, #"""
        {"prId":7,"title":"t","url":"u","org":"acme","project":"Proj X","repo":"web","author":"a","draft":true,
         "status":"active","createdAt":"c"}
        """#)
        let s = try await c.prSummary(az)
        #expect(path(try only(id).0) == "/api/sidecar/api/azure/pr/Proj%20X/web/7/summary?org=acme")
        #expect(s.state == "active" && s.updatedAt == "c" && s.ref == az)
    }

    @Test func providerNeutralRoutesTakeTheRefAsQueryOrBody() async throws {
        let (c, id) = client(200, #"{"guide":null}"#)
        #expect(try await c.prGuide(az) == nil)
        #expect(path(try only(id).0) == "/api/sidecar/api/pr/guide?provider=azure&org=acme&project=Proj%20X&repo=web&prId=7")
        let (c2, id2) = client(200, "null")
        #expect(try await c2.workspaceForPr(az) == nil)
        #expect(path(try only(id2).0)
            == "/api/sidecar/api/workspaces/for-pr?provider=azure&org=acme&project=Proj%20X&repo=web&number=7")
    }

    @Test func viewedMarksGoOnePathPerRequest() async throws {
        let (c, id) = client(200, "{}")
        try await c.setFileViewed(gh, path: "a.ts", viewed: false)
        #expect(try only(id).1 == .object(["path": .string("a.ts"), "viewed": .bool(false)]))
    }
}

@Suite struct ReviewTabSpecTests {
    @Test func idsMatchTheWebsAndClaudeIsOnePerWorkspace() {
        #expect(ReviewTabSpec.diff(prId: "p1", path: "src/a.ts").id == "diff:p1:src/a.ts")
        #expect(ReviewTabSpec.commit(prId: "p1", sha: sha).id == "commit:p1:\(sha)")
        #expect(ReviewTabSpec(kind: .claude, prId: "p2").id == "claude")
        #expect(ReviewTabSpec(kind: .sinceReview, prId: "p1").id == "since-review:p1")
    }

    @Test func titlesAndTooltips() {
        #expect(ReviewTabSpec.diff(prId: "p", path: "src/a.ts").title == "a.ts")
        #expect(ReviewTabSpec.commit(prId: "p", sha: sha, subject: "Fix").title == "aaaaaaa Fix")
        #expect(ReviewTabSpec.sinceFile(prId: "p", path: "a.ts", from: sha).tooltip == "a.ts — since your review at aaaaaaa")
    }

    @Test func revealLinesAreNeverSaved() throws {
        let spec = ReviewTabSpec.diff(prId: "p", path: "a.ts", revealLine: 40)
        let back = try JSONDecoder().decode(ReviewTabSpec.self, from: JSONEncoder().encode(spec))
        #expect(back.revealLine == nil && back.id == spec.id)
    }

    @Test func aPrOpensInTheActiveWorkspaceOpenedMostRecently() throws {
        let pr = try JSONDecoder().decode(ReviewWorkspacePr.self, from: json(prJSON))
        let older = ReviewWorkspace(id: "a", name: "A", createdAt: "2026-01-01", lastOpenedAt: "2026-02-01", prs: [pr])
        let newer = ReviewWorkspace(id: "b", name: "B", createdAt: "2026-03-01", prs: [pr])
        let gone = ReviewWorkspace(id: "c", name: "C", status: "archived", createdAt: "2026-12-01", prs: [pr])
        #expect(findReviewWorkspace(holding: gh, in: [older, newer, gone])?.workspaceId == "b")
        #expect(findReviewWorkspace(holding: az, in: [older, newer]) == nil)
    }
}

private extension JSONValue {
    var arrayFirst: JSONValue? {
        if case .array(let a) = self { return a.first }
        return nil
    }
}

@Suite struct ReviewSharedLogicTests {
    private func file(_ path: String) -> ReviewChangedFile { ReviewChangedFile(path: path) }

    @Test func fileOrderPutsFoldersFirstAtEachLevel() {
        let order = changedFileOrder([file("z.ts"), file("src/b.ts"), file("src/a/x.ts"), file("a.ts")])
        #expect(order == ["src/a/x.ts", "src/b.ts", "a.ts", "z.ts"])
    }

    @Test func nextUnviewedWrapsAndSkipsViewedFiles() {
        let order = ["a", "b", "c"]
        #expect(nextUnviewed(order: order, after: "b", viewed: ["c"]) == "a")
        #expect(nextUnviewed(order: order, after: "a", viewed: ["b", "c"]) == nil)
        #expect(nextUnviewed(order: order, after: "gone", viewed: []) == "a")
    }

    @Test func adjacentPathWrapsAndStartsAtAnEnd() {
        #expect(adjacentPath(["a", "b"], current: "b", forward: true) == "a")
        #expect(adjacentPath(["a", "b"], current: nil, forward: false) == "b")
        #expect(adjacentPath([], current: nil, forward: true) == nil)
    }
}

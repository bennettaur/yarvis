import Foundation
import Testing
@testable import YarvisClient

private func item(id: String = "i", source: String = "system", sessionKey: String?, kind: String = "permission",
                  payload: String? = nil) throws -> AttentionItem {
    AttentionItem(id: id, seq: 1, source: source, sessionKey: sessionKey, workspaceId: nil, kind: kind,
                  title: "t", body: nil, status: "pending", navTarget: nil,
                  payload: try payload.map { try JSONDecoder().decode(JSONValue.self, from: json($0)) },
                  createdAt: "", updatedAt: "")
}

private var utc: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "UTC")!
    return c
}

@Suite struct HeadsDownDecodingTests {
    @Test func stateAndPassesDecode() throws {
        let state = try JSONDecoder().decode(HeadsDownState.self, from: json(#"""
        {"run":{"id":"r","focus":null,"status":"active","startedAt":"2026-11-24T09:00:00.000Z","stoppedAt":null,
                "pausedAt":null,"stopAt":"2026-11-24T17:00:00.000Z"},
         "lastPass":null,"nextPassAt":"2026-11-24T10:00:00.000Z","openQuestionCount":2}
        """#))
        #expect(state.run?.stopAt == "2026-11-24T17:00:00.000Z")
        #expect(state.openQuestionCount == 2)

        let passes = try JSONDecoder().decode([HeadsDownPass].self, from: json(#"""
        [{"id":"p","runId":"r","chatSessionId":null,"startedAt":"x","finishedAt":"y","notes":"did it",
          "sleepMinutes":12,"sleepReason":null,"error":null,"callCount":3,
          "failedCalls":[{"name":"run","server":"gh","error":"boom"},{"name":"wait","server":null,"error":null,"noResult":true}]}]
        """#))
        #expect(passes.first?.failedCalls?.count == 2)
        #expect(passes.first?.sleepMinutes == 12)
    }

    @Test func aQuestionWithNullArgsHasNone() throws {
        let q = try JSONDecoder().decode(HeadsDownQuestion.self, from: json(#"""
        {"id":"q","kind":"approval","streamId":null,"question":"Run it?","situation":null,"options":[],
         "action":"mcp:gh:merge","toolArgs":null,"status":"open","choice":null,"answer":null,"answeredBy":null,
         "createdAt":"x","answeredAt":null}
        """#))
        #expect(q.toolArgs == nil)
        #expect(q.mcpTool == "mcp:gh:merge")
        #expect(HeadsDownQuestion(id: "b", kind: "approval", question: "", action: "github_merge", createdAt: "").mcpTool == nil)
        #expect(HeadsDownQuestion(id: "c", question: "", action: "mcp:x:y", createdAt: "").mcpTool == nil)
    }

    @Test func streamLinksDecodeByKind() throws {
        let streams = try JSONDecoder().decode([WorkStream].self, from: json(#"""
        [{"id":"s","title":"Ship","summary":null,"status":"active","priority":"high","nextAction":null,
          "waitingOn":null,"wakeAt":null,"pausedAt":null,"updatedAt":"x","links":[
           {"id":"1","kind":"ticket","ref":{"kind":"ticket","provider":"jira","key":"AB-1","url":"https://j/AB-1"},
            "title":null,"state":"In progress","observedAt":null},
           {"id":"2","kind":"workspace","ref":{"kind":"workspace","workspaceId":"W"},"title":null,"state":null,"observedAt":null},
           {"id":"3","kind":"pr","ref":{"kind":"pr","provider":"github","url":"https://gh/pr/1"},"title":"Fix","state":null,"observedAt":null},
           {"id":"4","kind":"slack","ref":{"kind":"slack"},"title":null,"state":null,"observedAt":null}]}]
        """#))
        let refs = streams[0].links.map(\.ref)
        #expect(refs == [.ticket(key: "AB-1", url: "https://j/AB-1"), .workspace(id: "W"),
                         .pr(url: "https://gh/pr/1"), .other(kind: "slack")])
    }

    @Test func streamEventsDecodeTheirInnerPassEvent() throws {
        let e = try HeadsDownStreamEvent.decode(json(
            #"{"type":"pass-event","passId":"p","event":{"type":"tool_call","id":"t","name":"read","args":{"a":1}}}"#))
        guard case .passEvent("p", .toolCall(let call)) = e else {
            Issue.record("got \(e)")
            return
        }
        #expect(call.name == "read" && call.status == "pending")
        #expect(try HeadsDownStreamEvent.decode(json(#"{"type":"changed"}"#)) == .changed)
        #expect(try HeadsDownStreamEvent.decode(json(#"{"type":"nope"}"#)) == .unknown)
    }

    @Test func theConfigBodySendsNullsRatherThanLeavingThemOut() {
        let body = HeadsDownConfig(workingHours: nil, provider: nil, model: nil, guidance: nil).body
        #expect(body["workingHours"] == .null)
        #expect(body["provider"] == .null)
        #expect(body["guidance"] == .null)
        #expect(body["maxRoutinesPerPass"] == .number(2))
    }
}

@Suite struct LivePassTests {
    @Test func reasoningJoinsUntilSomethingElseHappens() {
        var live = LivePass(passId: "p")
        live.apply(.reasoning("a"))
        live.apply(.reasoning("b"))
        #expect(live.thought == "ab" && live.isThinking)
        live.apply(.delta("hi"))
        #expect(!live.isThinking && live.text == "hi")
        live.apply(.reasoning("c"))
        #expect(live.thought == "c")
    }

    @Test func workAfterAnErrorClearsIt() {
        var live = LivePass(passId: "p")
        live.apply(.error(message: "rate limited", detail: nil))
        live.retrying = true
        #expect(live.error == "rate limited")
        live.apply(.toolCall(ToolActivity(id: "t", name: "x", status: "pending")))
        #expect(live.error == nil && !live.retrying)
        live.apply(.toolResult(id: "t", status: "ok", result: "done", durationMs: 5))
        #expect(live.activity.first?.status == "ok" && live.activity.first?.result == "done")
    }

    @Test func theStreamFollowsOnlyThePassItStarted() {
        var live = HeadsDownLive()
        let started = live.apply(.passStarted(passId: "p"))
        #expect(!started)
        _ = live.apply(.passEvent(passId: "other", event: .delta("x")))
        _ = live.apply(.passEvent(passId: "p", event: .delta("y")))
        _ = live.apply(.passRetrying(passId: "p"))
        #expect(live.pass?.text == "y" && live.pass?.retrying == true)
        let finished = live.apply(.passFinished(passId: "p"))
        #expect(finished && live.pass == nil)
        let changed = live.apply(.changed)
        let ping = live.apply(.ping)
        #expect(changed && !ping)
    }
}

@Suite struct HeadsDownRunTests {
    private let run = HeadsDownRun(id: "r", startedAt: "2026-11-24T09:00:00Z")

    @Test func theNextPassLine() {
        let next = "2026-11-24T10:00:00.000Z"
        #expect(NextPass(state: .init(run: run, nextPassAt: next), run: run, working: false)
            == .sleepingUntil(parseISODate(next)!))
        #expect(NextPass(state: .init(run: run, nextPassAt: next), run: run, working: true) == .working)
        var paused = run
        paused.pausedAt = "x"
        #expect(NextPass(state: .init(run: paused), run: paused, working: true) == .paused)
        var stopping = run
        stopping.stopAt = "y"
        let last = HeadsDownPass(id: "p", runId: "r", startedAt: "x")
        #expect(NextPass(state: .init(run: stopping, lastPass: last), run: stopping, working: false) == .noneBeforeStop)
        #expect(NextPass(state: .init(run: run), run: run, working: false) == .starting)
    }

    @Test func theMarkWorksUntilANextPassIsScheduled() {
        #expect(HeadsDownAgentState(state: .init(run: nil), working: false) == .off)
        #expect(HeadsDownAgentState(state: .init(run: run), working: false) == .working)
        #expect(HeadsDownAgentState(state: .init(run: run, nextPassAt: "x"), working: false) == .sleeping)
        var paused = run
        paused.pausedAt = "x"
        #expect(HeadsDownAgentState(state: .init(run: paused), working: true) == .sleeping)
    }

    @Test func aStopTimeIsTodayOrTomorrow() {
        let now = parseISODate("2026-11-24T12:30:00Z")!
        #expect(nextOccurrence("19:00", now: now, calendar: utc) == "2026-11-24T19:00:00Z")
        #expect(nextOccurrence("12:30", now: now, calendar: utc) == "2026-11-25T12:30:00Z")
        #expect(nextOccurrence("9:5", now: now, calendar: utc) == "2026-11-25T09:05:00Z")
        #expect(nextOccurrence("25:00", now: now, calendar: utc) == nil)
        #expect(nextOccurrence("12:60", now: now, calendar: utc) == nil)
        #expect(nextOccurrence("12", now: now, calendar: utc) == nil)
        #expect(hhmm(now, calendar: utc) == "12:30")
    }
}

@Suite struct HeadsDownTextTests {
    @Test func sleepAndCalls() {
        #expect(describeSleep(HeadsDownPass(id: "p", runId: "r", startedAt: "", sleepMinutes: 12, sleepReason: "idle"))
            == "Then slept 12 min (idle)")
        #expect(describeSleep(HeadsDownPass(id: "p", runId: "r", startedAt: "", sleepMinutes: 5, sleepReason: "stopped by you"))
            == "Stopped by you")
        #expect(describeSleep(HeadsDownPass(id: "p", runId: "r", startedAt: "")) == nil)
        let calls = [HeadsDownFailedCall(name: "a", server: "gh", error: "boom"),
                     HeadsDownFailedCall(name: "b", server: nil, error: nil, noResult: true)]
        #expect(describeCalls(HeadsDownPass(id: "p", runId: "r", startedAt: "", callCount: 1)) == "1 tool call")
        #expect(describeCalls(HeadsDownPass(id: "p", runId: "r", startedAt: "", callCount: 4, failedCalls: calls))
            == "4 tool calls · 1 failed · 1 with no result")
        #expect(describeFailedCall(calls[0]) == "gh/a: boom")
        #expect(describeFailedCall(calls[1]) == "b: no result")
    }

    @Test func linkLabelsNameWhatTheyPointAt() {
        let date: (Date) -> String = { _ in "D" }
        let ws = WorkStreamLink(id: "1", ref: .workspace(id: "ABC"))
        #expect(workStreamLinkLabel(ws, workspaceNames: ["abc": "Billing"], date: date) == "workspace: Billing")
        #expect(workStreamLinkLabel(ws, workspaceNames: [:], date: date) == "workspace")
        let ticket = WorkStreamLink(id: "2", ref: .ticket(key: "AB-1", url: nil), state: "open")
        #expect(workStreamLinkLabel(ticket, workspaceNames: [:], date: date) == "ticket: AB-1 · open")
        let review = WorkStreamLink(id: "3", ref: .reviewRequest(conversation: "#eng", sentAt: "2026-11-24T09:00:00Z"))
        #expect(workStreamLinkLabel(review, workspaceNames: [:], date: date) == "review request, sent D: #eng")
        #expect(workStreamLinkTarget(ws) == .workspace("ABC"))
        #expect(workStreamLinkTarget(ticket) == nil)
        #expect(workStreamLinkTarget(WorkStreamLink(id: "4", ref: .pr(url: "https://gh/1"))) == .web(URL(string: "https://gh/1")!))
    }

    @Test func cadenceReadsBackAsWritten() {
        #expect(routineCadence(30) == "every 30m")
        #expect(routineCadence(180) == "every 3h")
        #expect(routineCadence(2880) == "every 2d")
    }

    @Test func onlyKnownStandaloneIdsBecomeMentions() {
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e"
        let names = [id.uppercased(): "Billing"]
        #expect(splitWorkspaceMentions("see \(id.uppercased()) now", names: names)
            == [.text("see "), .workspace(id: id, name: "Billing"), .text(" now")])
        #expect(splitWorkspaceMentions("/w/\(id)", names: names) == [.text("/w/\(id)")])
        #expect(splitWorkspaceMentions("plain", names: [:]) == [.text("plain")])
    }
}

@Suite struct HeadsDownAttentionTests {
    @Test func onlySystemNonQuestionItemsAreHeadsDownQuestions() throws {
        #expect(headsDownQuestionId(try item(sessionKey: "heads-down:q1")) == "q1")
        #expect(headsDownQuestionId(try item(sessionKey: "heads-down:q1", kind: "question")) == nil)
        #expect(headsDownQuestionId(try item(source: "chat-agent", sessionKey: "heads-down:q1")) == nil)
        #expect(headsDownQuestionId(try item(sessionKey: "heads-down:")) == nil)
    }

    @Test func theClickedQuestionGoesFirstThenOldest() {
        let qs = [HeadsDownQuestion(id: "c", question: "", createdAt: "3"),
                  HeadsDownQuestion(id: "a", question: "", createdAt: "1"),
                  HeadsDownQuestion(id: "b", question: "", createdAt: "2")]
        #expect(orderQuestions(qs, first: "c").map(\.id) == ["c", "a", "b"])
        #expect(orderQuestions(qs, first: nil).map(\.id) == ["a", "b", "c"])
    }

    @Test func mergeAnnouncementsNeedAKnownRiskAndANumberOrNull() throws {
        let merge = try #require(mergeAnnouncement(of: item(sessionKey: "heads-down-merge:1", kind: "info", payload:
            #"{"headsDownMerge":{"repo":"o/r","number":7,"title":"Fix","risk":"low","why":"green"}}"#)))
        #expect(merge.label == "o/r#7" && merge.risk == .low)
        let unknownPr = try #require(mergeAnnouncement(of: item(sessionKey: "heads-down-merge:1", payload:
            #"{"headsDownMerge":{"repo":"","number":null,"risk":"unknown","why":""}}"#)))
        #expect(unknownPr.label == "A PR in a workspace")
        #expect(mergeAnnouncement(of: try item(sessionKey: "heads-down-merge:1", payload:
            #"{"headsDownMerge":{"repo":"o/r","number":7,"risk":"spicy","why":""}}"#)) == nil)
        #expect(mergeAnnouncement(of: try item(sessionKey: "heads-down-merge:1", payload:
            #"{"headsDownMerge":{"repo":"o/r","risk":"low","why":""}}"#)) == nil)
        #expect(mergeAnnouncement(of: try item(source: "claude-hook", sessionKey: "heads-down-merge:1", payload:
            #"{"headsDownMerge":{"repo":"o/r","number":7,"risk":"low","why":""}}"#)) == nil)
    }

    @Test func aHeldMergeReadsItsFeedbackAndWhereReviewGoes() throws {
        let review = try #require(mergeReview(of: item(sessionKey: "heads-down:q9", payload: #"""
        {"headsDownMergeReview":{"questionId":"q9","unchecked":null,"prs":[
          {"repo":"o/r","number":3,"title":"T","workspaceId":null,"handedOff":false,"threadCount":3,
           "threadsTruncated":false,"changesRequestedBy":["ann"],"fromOutsiders":false,
           "threads":[{"path":"a.ts","line":4,"outdated":true,"author":"bob","body":"nit","replies":2}]}]}}
        """#)))
        #expect(review.label == "o/r#3")
        #expect(review.prs[0].handoffNote == "No workspace has this PR, so nobody was asked to address it.")
        #expect(review.prs[0].moreThreadsNote == "2 more unresolved threads on the PR.")
        #expect(review.prs[0].threads[0].heading == "Reviewer comment from bob on a.ts:4 (outdated) · 2 replies")
        #expect(review.reviewURL == URL(string: "https://github.com/o/r/pull/3"))
        #expect(MergeReview(questionId: "q", prs: [], unchecked: "no token").reviewURL == nil)
        #expect(gitHubPullRequestURL(repo: "no-slash", number: 1) == nil)
        #expect(gitHubPullRequestURL(repo: "o/r/x", number: 1) == nil)
        let target = try JSONDecoder().decode(JSONValue.self, from: json(#"{"type":"pr","owner":"o","repo":"r","number":9}"#))
        #expect(gitHubPullRequestURL(navTarget: target) == URL(string: "https://github.com/o/r/pull/9"))
        #expect(gitHubPullRequestURL(navTarget: .object(["type": .string("workspace")])) == nil)
        #expect(mergeReview(of: try item(sessionKey: "heads-down:q9", kind: "info", payload:
            #"{"headsDownMergeReview":{"questionId":"q9","prs":[]}}"#)) == nil)
    }
}

@Suite struct HeadsDownSettingsTests {
    private let providers = [
        ProviderInfo(id: "a", label: "A", models: [ModelInfo(id: "a1", capabilities: []), ModelInfo(id: "a2", capabilities: [])],
                     available: true),
        ProviderInfo(id: "b", label: "B", models: [ModelInfo(id: "b1", capabilities: [])], available: false),
    ]

    @Test func aSavedModelOutOfTheCatalogueIsStale() {
        #expect(!HeadsDownModelChoice(provider: "a", model: "a2", providers: providers).stale)
        #expect(HeadsDownModelChoice(provider: "a", model: "gone", providers: providers).stale)
        #expect(HeadsDownModelChoice(provider: "z", model: "z1", providers: providers).providerMissing)
        #expect(HeadsDownModelChoice(provider: "b", model: "b1", providers: providers).stale)
        // Not stale before the catalogue has loaded.
        #expect(!HeadsDownModelChoice(provider: "z", model: "z1", providers: nil).stale)
        #expect(!HeadsDownModelChoice(provider: nil, model: nil, providers: providers).stale)
    }

    @Test func pickingAProviderPicksItsFirstModel() {
        let choice = HeadsDownModelChoice(provider: nil, model: nil, providers: providers)
        #expect(choice.picking(provider: "a") == ("a", "a1"))
        #expect(choice.picking(provider: nil) == (nil, nil))
        #expect(choice.picking(provider: "missing") == (nil, nil))
    }

    @Test func daysToggleAndStaySorted() {
        let hours = WorkingHours(days: [1, 5], start: "09:00", end: "17:00")
        #expect(hours.toggling(day: 3).days == [1, 3, 5])
        #expect(hours.toggling(day: 5).days == [1])
    }
}

@Suite struct HeadsDownAPITests {
    private func client(_ status: Int = 200, _ body: String = "{}") -> (YarvisClient, String) {
        let (session, id) = StubProtocol.session { _, _ in (status, json(body)) }
        return (YarvisClient(baseURL: base, token: "tok", session: session), id)
    }

    private func recorded(_ id: String) -> [(method: String?, path: String?, body: JSONValue?)] {
        StubProtocol.recorded(id).map { ($0.0.httpMethod, $0.0.url?.path, bodyJSON($0.1)) }
    }

    @Test func runControlsGoThroughTheSidecar() async throws {
        let (c, id) = client()
        try await c.startHeadsDown(focus: "ship", stopAt: nil)
        try await c.startHeadsDown(focus: "", stopAt: "2026-11-24T19:00:00.000Z")
        try await c.setHeadsDownStopAt(nil)
        try await c.pauseHeadsDown()
        let reqs = recorded(id)
        #expect(reqs[0].path == "/api/sidecar/api/heads-down/start")
        #expect(reqs[0].body == .object(["focus": .string("ship")]))
        #expect(reqs[1].body?["stopAt"] == .string("2026-11-24T19:00:00.000Z"))
        #expect(reqs[2].method == "PUT" && reqs[2].body == .object(["stopAt": .null]))
        #expect(reqs[3].path == "/api/sidecar/api/heads-down/pause")
    }

    @Test func answersAndStreamPatchesSendOnlyWhatWasGiven() async throws {
        let (c, id) = client()
        try await c.answerHeadsDownQuestion(id: "q", choice: "approve")
        try await c.answerHeadsDownQuestion(id: "q", answer: "later")
        try await c.updateWorkStream(id: "s", paused: true)
        try await c.setHeadsDownToolAllowed("mcp:gh:merge", allowed: false)
        let reqs = recorded(id)
        #expect(reqs[0].path == "/api/sidecar/api/heads-down/questions/q/answer")
        #expect(reqs[0].body == .object(["choice": .string("approve")]))
        #expect(reqs[1].body == .object(["answer": .string("later")]))
        #expect(reqs[2].method == "PATCH" && reqs[2].body == .object(["paused": .bool(true)]))
        let toolPath = StubProtocol.recorded(id)[3].0.url?.absoluteString ?? ""
        #expect(toolPath.hasSuffix("/heads-down/allowed-tools/mcp:gh:merge"))
    }

    @Test func aPassTranscriptIsItsMessages() async throws {
        let (c, _) = client(200, #"""
        {"pass":{"id":"p","runId":"r","startedAt":"x"},"messages":[
          {"id":"m","role":"assistant","content":"done","toolCalls":null,"createdAt":"x"}]}
        """#)
        #expect(try await c.headsDownPassMessages(id: "p").map(\.content) == ["done"])
    }
}

@Suite struct HeadsDownReviewFixTests {
    @Test func aStopTimeAcrossASpringForwardKeepsItsWallTime() throws {
        var toronto = Calendar(identifier: .gregorian)
        toronto.timeZone = try #require(TimeZone(identifier: "America/Toronto"))
        // 20:00 EST on 7 March 2026; clocks go forward that night.
        let now = parseISODate("2026-03-08T01:00:00Z")!
        #expect(nextOccurrence("19:00", now: now, calendar: toronto) == "2026-03-08T23:00:00Z")
        // 02:30 doesn't exist that night; the calendar moves it on rather than failing.
        #expect(nextOccurrence("02:30", now: now, calendar: toronto) != nil)
        #expect(parseHHMM("07:05")! == (7, 5))
        #expect(parseHHMM("7:") == nil)
        #expect(dateForHHMM("24:00") == nil)
    }

    @Test func retryingFollowsTheStreamsOwnOrder() throws {
        var live = HeadsDownLive()
        let frames = [
            #"{"type":"pass-started","passId":"p"}"#,
            #"{"type":"pass-event","passId":"p","event":{"type":"reasoning","text":"plan"}}"#,
            #"{"type":"pass-event","passId":"p","event":{"type":"error","message":"overloaded","transient":true}}"#,
            #"{"type":"pass-retrying","passId":"p","retryAt":"2026-11-24T10:00:00Z"}"#,
        ]
        for frame in frames { _ = live.apply(try HeadsDownStreamEvent.decode(json(frame))) }
        #expect(live.pass?.error == "overloaded" && live.pass?.retrying == true && live.pass?.isThinking == false)
        _ = live.apply(try HeadsDownStreamEvent.decode(json(
            #"{"type":"pass-event","passId":"p","event":{"type":"delta","text":"back"}}"#)))
        #expect(live.pass?.error == nil && live.pass?.retrying == false && live.pass?.text == "back")
    }

    @Test func theFirstLineSkipsLeadingBlanks() {
        #expect(firstLine(of: "\n  first\nsecond") == "first")
        #expect(firstLine(of: "") == "")
    }

    @Test func onlyWorkspaceLinksMoveTheAppFromPassText() {
        let ws = URL(string: "yarvis://workspace/0f8fad5b-d9cb-469f-a165-70867728950e")!
        #expect(headsDownLinkAction(ws) == .openPlace(ws))
        #expect(headsDownLinkAction(URL(string: "yarvis://settings/devices")!) == .ignore)
        #expect(headsDownLinkAction(URL(string: "yarvis://artifact/0f8fad5b-d9cb-469f-a165-70867728950e")!) == .ignore)
        let web = URL(string: "https://example.com")!
        #expect(headsDownLinkAction(web) == .openInBrowser(web))
        #expect(headsDownLinkAction(URL(string: "file:///etc/passwd")!) == .ignore)
    }

    @Test func anMcpApprovalNamesItsTool() {
        let q = HeadsDownQuestion(id: "q", kind: "approval", question: "", action: "mcp:github:merge_pr", createdAt: "")
        #expect(q.mcpToolName == "merge_pr")
    }
}

@Suite struct HeadsDownQuestionFlowTests {
    private func q(_ id: String, _ at: String) -> HeadsDownQuestion {
        HeadsDownQuestion(id: id, question: id, createdAt: at)
    }

    @Test func anAnswerShowsTheNextAndTheLastCloses() {
        var flow = HeadsDownQuestionFlow(firstId: "b")
        let closes1 = flow.apply(.loaded([q("a", "1"), q("b", "2")]))
        #expect(!closes1)
        #expect(flow.current?.id == "b")
        flow.answered()
        #expect(flow.reloading)
        let closes2 = flow.apply(.loaded([q("a", "1")]))
        #expect(!closes2)
        #expect(flow.current?.id == "a" && !flow.reloading)
        flow.answered()
        let closes3 = flow.apply(.loaded([]))
        #expect(closes3)
    }

    @Test func aFailedReloadDropsTheAnsweredQuestionAndClearsReloading() {
        var flow = HeadsDownQuestionFlow(firstId: nil)
        _ = flow.apply(.loaded([q("a", "1"), q("b", "2")]))
        flow.answered()
        let closes4 = flow.apply(.failed("offline"))
        #expect(!closes4)
        #expect(flow.current?.id == "b" && flow.error == "offline" && !flow.reloading)
    }

    @Test func aLoadNotAfterAnAnswerNeverCloses() {
        var flow = HeadsDownQuestionFlow(firstId: nil)
        let closes5 = flow.apply(.loaded([]))
        #expect(!closes5)
        #expect(flow.questions == [])
        // A failed first load keeps nothing to drop.
        var empty = HeadsDownQuestionFlow(firstId: nil)
        let closes6 = empty.apply(.failed("x"))
        #expect(!closes6)
        #expect(empty.questions == nil)
    }
}

@Suite struct HeadsDownPopupTests {
    private let review = #"{"headsDownMergeReview":{"questionId":"q","unchecked":"no token","prs":[]}}"#
    private let merge = #"{"headsDownMerge":{"repo":"o/r","number":1,"risk":"low","why":"green"}}"#

    @Test func aHeldMergeWinsThenMergesThenQuestions() throws {
        let items = [
            try item(id: "m1", sessionKey: "heads-down-merge:1", kind: "info", payload: merge),
            try item(id: "r1", sessionKey: "heads-down:q1", payload: review),
            try item(id: "r2", sessionKey: "heads-down:q2", payload: review),
            try item(id: "m2", sessionKey: "heads-down-merge:2", kind: "info", payload: merge),
        ]
        guard case .review(let first, _, let remaining)? = HeadsDownPopup.choose(items: items, deferred: [], questionsOpen: true)
        else { Issue.record("expected a review"); return }
        #expect(first.id == "r1" && remaining == 1)
        guard case .merge(let m, _, let left)? = HeadsDownPopup.choose(items: items, deferred: ["r1", "r2"], questionsOpen: true)
        else { Issue.record("expected a merge"); return }
        #expect(m.id == "m1" && left == 1)
        #expect(HeadsDownPopup.choose(items: [], deferred: [], questionsOpen: true) == .questions)
        #expect(HeadsDownPopup.choose(items: [], deferred: [], questionsOpen: false) == nil)
    }
}

@Suite struct HeadsDownRoutesTests {
    private let fixtures: [String: String] = [
        "/api/sidecar/api/heads-down": #"{"run":null,"lastPass":null,"nextPassAt":null,"openQuestionCount":0}"#,
        "/api/sidecar/api/heads-down/config": #"""
            {"minSleepMinutes":5,"maxSleepMinutes":120,"idleSleepMinutes":60,
             "workingHours":{"days":[1,2,3,4,5],"start":"09:00","end":"17:00"},"userAwayAfterMinutes":120,
             "passTimeoutMinutes":20,"provider":null,"model":null,"guidance":null,"maxRoutinesPerPass":2}
            """#,
        "/api/sidecar/api/heads-down/routines": #"""
            {"routines":[{"name":"triage","description":"Sort new issues","everyMinutes":180,"workingHoursOnly":true,
              "enabled":true,"source":"builtin","lastDoneAt":null}],
             "problems":[{"path":"/u/.yarvis/routines/bad.md","message":"no description"}],
             "userDir":"/u/.yarvis/routines"}
            """#,
        "/api/sidecar/api/heads-down/routines/reload": #"{"routines":[],"problems":[],"userDir":"/u"}"#,
        "/api/sidecar/api/heads-down/allowed-tools": #"[{"id":"mcp:gh:merge","name":"merge"}]"#,
        "/api/sidecar/api/heads-down/passes/p": #"{"pass":{"id":"p","runId":"r","startedAt":"x"},"messages":[]}"#,
        "/api/sidecar/api/work-streams": "[]",
        "/api/sidecar/api/heads-down/questions": "[]",
        "/api/sidecar/api/heads-down/auto-approvals": "[]",
        "/api/sidecar/api/heads-down/passes": "[]",
        "/api/sidecar/api/heads-down/messages": "[]",
    ]

    private func client() -> (YarvisClient, String) {
        let fixtures = fixtures
        let (session, id) = StubProtocol.session { req, _ in
            let path = req.url?.path ?? ""
            return (200, json(req.httpMethod == "GET" || path.hasSuffix("/reload") ? fixtures[path] ?? "{}" : "{}"))
        }
        return (YarvisClient(baseURL: base, token: "tok", session: session), id)
    }

    @Test func realResponsesDecode() async throws {
        let (c, _) = client()
        let config = try await c.headsDownConfig()
        #expect(config == HeadsDownConfig())
        let routines = try await c.headsDownRoutines()
        #expect(routines.routines.first?.everyMinutes == 180 && routines.problems.count == 1)
        #expect(try await c.headsDownAllowedTools() == [HeadsDownAllowedTool(id: "mcp:gh:merge", name: "merge")])
    }

    @Test func everyRouteUsesItsMethodAndPath() async throws {
        let (c, id) = client()
        _ = try await c.headsDownState()
        try await c.startHeadsDown(focus: "")
        try await c.stopHeadsDown()
        try await c.pauseHeadsDown()
        try await c.resumeHeadsDown()
        try await c.clearHeadsDown()
        try await c.setHeadsDownStopAt(nil)
        _ = try await c.headsDownConfig()
        try await c.saveHeadsDownConfig(HeadsDownConfig())
        _ = try await c.headsDownAllowedTools()
        try await c.setHeadsDownToolAllowed("t", allowed: true)
        _ = try await c.headsDownRoutines()
        _ = try await c.reloadHeadsDownRoutines()
        _ = try await c.headsDownPasses()
        _ = try await c.headsDownPassMessages(id: "p")
        _ = try await c.headsDownMessages()
        try await c.sendHeadsDownMessage("hi")
        _ = try await c.headsDownQuestions()
        _ = try await c.headsDownAutoApprovals()
        try await c.answerHeadsDownQuestion(id: "q", choice: "approve")
        try await c.dismissHeadsDownQuestion(id: "q")
        _ = try await c.workStreams()
        try await c.updateWorkStream(id: "s", status: "done")
        let hd = "/api/sidecar/api/heads-down"
        let got = StubProtocol.recorded(id).map { "\($0.0.httpMethod ?? "") \($0.0.url?.path ?? "")" }
        #expect(got == [
            "GET \(hd)", "POST \(hd)/start", "POST \(hd)/stop", "POST \(hd)/pause", "POST \(hd)/resume",
            "POST \(hd)/clear", "PUT \(hd)/stop-at", "GET \(hd)/config", "PUT \(hd)/config",
            "GET \(hd)/allowed-tools", "PUT \(hd)/allowed-tools/t", "GET \(hd)/routines", "POST \(hd)/routines/reload",
            "GET \(hd)/passes", "GET \(hd)/passes/p", "GET \(hd)/messages", "POST \(hd)/messages",
            "GET \(hd)/questions", "GET \(hd)/auto-approvals", "POST \(hd)/questions/q/answer",
            "POST \(hd)/questions/q/dismiss", "GET /api/sidecar/api/work-streams", "PATCH /api/sidecar/api/work-streams/s",
        ])
    }

    @Test func aLoadKeepsWhatItReadWhenOneListFails() async throws {
        let fixtures = fixtures
        let (session, _) = StubProtocol.session { req, _ in
            let path = req.url?.path ?? ""
            if path.hasSuffix("/work-streams") || path.hasSuffix("/auto-approvals") {
                return (500, json(#"{"error":"down"}"#))
            }
            if path.hasSuffix("/routines") { return (503, json(#"{"error":"no db"}"#)) }
            return (200, json(fixtures[path] ?? "{}"))
        }
        let load = await HeadsDownLoad.read(YarvisClient(baseURL: base, token: "tok", session: session))
        #expect(load.state != nil && load.questions == [] && load.passes == [] && load.messages == [])
        #expect(load.streams == nil && load.failure == "down")
        // A failed auto-approvals read isn't a page error.
        #expect(load.autoApprovals == nil)
        #expect(load.routines == nil && load.routinesFailure == "no db")
    }
}

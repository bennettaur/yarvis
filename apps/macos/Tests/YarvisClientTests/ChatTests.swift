import Foundation
import Testing
@testable import YarvisClient

@Suite struct ChatTabsTests {
    @Test func aTabThatHasTheSessionIsFocused() {
        var s = ChatTabsState(tabs: [.init(id: "a", sessionId: "s1"), .init(id: "b")], activeId: "b")
        let shown = s.open(sessionId: "s1", newTabId: "n", activeTabIdle: true)
        #expect(shown == "a")
        #expect(s.activeId == "a")
        #expect(s.tabs.count == 2)
    }

    @Test func anEmptyIdleActiveTabTakesTheSession() {
        var s = ChatTabsState.single("a")
        let shown = s.open(sessionId: "s1", newTabId: "n", activeTabIdle: true)
        #expect(shown == "a")
        #expect(s.tabs == [.init(id: "a", sessionId: "s1")])
    }

    @Test func aBusyOrFullActiveTabOpensANewOne() {
        var busy = ChatTabsState.single("a")
        let shown = busy.open(sessionId: "s1", newTabId: "n", activeTabIdle: false)
        #expect(shown == "n")
        #expect(busy.tabs.map(\.id) == ["a", "n"])
        #expect(busy.activeId == "n")

        var full = ChatTabsState(tabs: [.init(id: "a", sessionId: "s0")], activeId: "a")
        full.open(sessionId: "s1", newTabId: "n", activeTabIdle: true)
        #expect(full.tabs.map(\.sessionId) == ["s0", "s1"])
    }

    @Test func closingFocusesTheNeighbourAndNeverLeavesNoTabs() {
        var s = ChatTabsState(tabs: [.init(id: "a"), .init(id: "b"), .init(id: "c")], activeId: "c")
        s.close("c", newTabId: "x")
        #expect(s.activeId == "b")
        s.close("a", newTabId: "x")
        #expect(s.activeId == "b")
        s.close("b", newTabId: "x")
        #expect(s == .single("x"))
    }

    @Test func restoresWhatWasSavedAndRepairsTheActiveId() throws {
        let saved = ChatTabsState(tabs: [.init(id: "a", sessionId: "s1"), .init(id: "b")], activeId: "b")
        #expect(ChatTabsState.restore(try JSONEncoder().encode(saved)) == saved)
        #expect(ChatTabsState.restore(json(#"{"tabs":[{"id":"a","sessionId":null}],"activeId":"gone"}"#))?.activeId == "a")
        #expect(ChatTabsState.restore(json(#"{"tabs":[],"activeId":"a"}"#)) == nil)
        #expect(ChatTabsState.restore(nil) == nil)
    }

    @Test func labels() {
        let sessions = [ChatSession(id: "s1", title: "Trip", createdAt: "", updatedAt: ""),
                        ChatSession(id: "s2", title: nil, createdAt: "", updatedAt: "")]
        #expect(chatTabLabel(sessionId: nil, sessions: sessions) == "New chat")
        #expect(chatTabLabel(sessionId: "s1", sessions: sessions) == "Trip")
        #expect(chatTabLabel(sessionId: "s2", sessions: sessions) == "Untitled chat")
        #expect(chatTabLabel(sessionId: "unlisted", sessions: sessions) == "Untitled chat")
    }
}

@Suite struct ChatMessageRulesTests {
    @Test func messageLabelsNameTheSurface() {
        #expect(chatMessageLabel(role: "You", metadata: nil) == "You")
        #expect(chatMessageLabel(role: "You", metadata: .init(source: "voice")) == "You · spoken")
        #expect(chatMessageLabel(role: "You", metadata: .init(source: "browser")) == "You · Chrome")
        #expect(chatMessageLabel(role: "You", metadata: .init(source: "scheduled-task")) == "Yarvis · scheduled task")
        #expect(chatMessageLabel(role: "You", metadata: .init(source: "telegram", telegramUserId: 42,
                                                              telegramUsername: "mo", telegramFirstName: "Mo"))
            == "Telegram · @mo")
        #expect(chatMessageLabel(role: "You", metadata: .init(source: "telegram", telegramUserId: 42,
                                                              telegramFirstName: "Mo")) == "Telegram · Mo")
        #expect(chatMessageLabel(role: "You", metadata: .init(source: "telegram", telegramUserId: 42))
            == "Telegram · 42")
        #expect(chatMessageLabel(role: "You", metadata: .init(source: "telegram")) == "Telegram")
    }

    @Test func messagesDecodeTheirMetadata() throws {
        let m = try JSONDecoder().decode(ChatMessage.self, from: json(#"""
            {"id":"m1","sessionId":"s","role":"user","content":"hi","createdAt":"t",
             "metadata":{"source":"telegram","telegramUserId":7,"telegramUsername":"x"}}
            """#))
        #expect(m.metadata == ChatMessageMetadata(source: "telegram", telegramUserId: 7, telegramUsername: "x"))
        let plain = try JSONDecoder().decode(ChatMessage.self, from: json(#"""
            {"id":"m1","sessionId":"s","role":"user","content":"hi","createdAt":"t","metadata":null}
            """#))
        #expect(plain.metadata == nil)
    }

    func msg(_ id: String, _ role: String, _ content: String) -> ChatMessage {
        ChatMessage(id: id, sessionId: "s", role: role, content: content, createdAt: "")
    }

    @Test func aTurnAddsOneUserBubble() {
        let thread = [msg("1", "user", "hi"), msg("2", "assistant", "hello")]
        let next = messagesForTurn(thread, text: "again", sessionId: "s")
        #expect(next.count == 3)
        #expect(next.last?.content == "again")
        #expect(next.last.map(isSavedMessage) == false)
    }

    @Test func aResendOrRepeatAddsNoSecondBubble() {
        let failed = [msg("1", "user", "hi")]
        #expect(messagesForTurn(failed, text: "hi", sessionId: "s") == failed)
        let thread = [msg("1", "user", "hi"), msg("2", "assistant", "hello")]
        #expect(messagesForTurn(thread, text: "hi", sessionId: "s", resend: true) == thread)
    }

    @Test func aRewindDropsTheMessageAndEverythingAfter() {
        let thread = [msg("1", "user", "a"), msg("2", "assistant", "b"), msg("3", "user", "c"), msg("4", "assistant", "d")]
        let next = messagesForTurn(thread, text: "c, edited", sessionId: "s", rewindTo: "3")
        #expect(next.map(\.content) == ["a", "b", "c, edited"])
    }

    @Test func toolSummaries() {
        let ok = ToolActivity(id: "1", name: "a", status: "ok")
        let bad = ToolActivity(id: "2", name: "b", status: "error")
        let denied = ToolActivity(id: "3", name: "c", status: "denied")
        #expect(toolActivitySummary([], thought: true) == "Thought about it")
        #expect(toolActivitySummary([ok], thought: false) == "Used 1 tool call")
        #expect(toolActivitySummary([ok, bad, denied], thought: false) == "Used 3 tool calls · 2 failed")
        #expect(toolActivitySummary([ok, ok], thought: true) == "Thought, 2 tool calls")
    }

    @Test func durations() {
        #expect(formatToolDuration(4) == "4 ms")
        #expect(formatToolDuration(999) == "999 ms")
        #expect(formatToolDuration(1000) == "1.0 s")
        #expect(formatToolDuration(12_345) == "12.3 s")
    }
}

@Suite struct MessageQueueTests {
    @Test func drainsOnePerCleanTurn() {
        var q = MessageQueue()
        let queuedBlank = q.enqueue("  ")
        #expect(!queuedBlank)
        q.enqueue(" one ")
        q.enqueue("two")
        let next1 = q.drain()
        #expect(next1 == "one")
        #expect(q.items == ["two"])
    }

    @Test func aFailedTurnHoldsTheQueueUntilTheUserSends() {
        var q = MessageQueue()
        q.enqueue("one")
        q.turnEnded(failed: true)
        #expect(q.held)
        let next2 = q.drain()
        #expect(next2 == nil)
        let next3 = q.takeNext()
        #expect(next3 == "one")
        q.turnStarted()
        #expect(!q.held)
    }

    @Test func aRefusedSendGoesBackToTheFrontAndHolds() {
        var q = MessageQueue()
        q.enqueue("two")
        q.sendRefused("one")
        #expect(q.items == ["one", "two"])
        let next4 = q.drain()
        #expect(next4 == nil)
    }

    @Test func removingAndClearing() {
        var q = MessageQueue()
        q.enqueue("a")
        q.enqueue("b")
        q.remove(at: 0)
        q.remove(at: 5)
        #expect(q.items == ["b"])
        q.turnEnded(failed: true)
        q.clear()
        #expect(q == MessageQueue())
    }
}

@Suite struct LiveTurnReasoningTests {
    @Test func reasoningIsTimedUntilTheReplyStarts() {
        let t0 = Date(timeIntervalSince1970: 100)
        var t = LiveTurn()
        t.apply(.reasoning("hm"), at: t0)
        t.apply(.reasoning(", ok"), at: t0.addingTimeInterval(1))
        #expect(t.isReasoning)
        #expect(t.reasoningSeconds == nil)
        t.apply(.delta("Hi"), at: t0.addingTimeInterval(4.2))
        #expect(!t.isReasoning)
        #expect(t.reasoning == "hm, ok")
        #expect(t.reasoningSeconds == 4)
        #expect(t.finish(cancelled: false) == .saved)
        #expect(t.reasoning == "hm, ok")
    }

    @Test func aToolCallOrTheEndAlsoStopsTheClock() {
        let t0 = Date(timeIntervalSince1970: 100)
        var tool = LiveTurn()
        tool.apply(.reasoning("hm"), at: t0)
        tool.apply(.toolCall(ToolActivity(id: "c", name: "x", status: "pending")), at: t0.addingTimeInterval(2))
        #expect(tool.reasoningSeconds == 2)

        var ended = LiveTurn()
        ended.apply(.reasoning("hm"), at: t0)
        _ = ended.finish(cancelled: true, at: t0.addingTimeInterval(0.2))
        #expect(ended.reasoningSeconds == 1)
    }

    @Test func noReasoningIsNoTiming() {
        var t = LiveTurn()
        t.apply(.delta("Hi"))
        #expect(t.reasoningStartedAt == nil)
        #expect(t.reasoningSeconds == nil)
    }

    @Test func aRequestFailureKeepsItsDetailApart() {
        var t = LiveTurn()
        t.apply(.delta("part"))
        t.fail(TurnFailure(YarvisError.http(status: 404, error: "rewindTo is not a user message in this session",
                                            detail: nil)))
        #expect(t.reply.isEmpty)
        #expect(t.failure == TurnFailure(message: "rewindTo is not a user message in this session"))
        #expect(TurnFailure(YarvisError.http(status: 400, error: "bad", detail: "why")) == TurnFailure(message: "bad", detail: "why"))
    }

    @Test func aToolCallWithNoNameIsNamedByItsId() throws {
        #expect(try ChatStreamEvent.decode(json(#"{"type":"tool_call","id":"c9"}"#))
            == .toolCall(ToolActivity(id: "c9", name: "c9", status: "pending")))
    }
}

@Suite struct ChatRequestTests {
    @Test func aTurnSendsReasoningAndRewindOnlyWhenSet() async throws {
        let (session, id) = StubProtocol.session { _, _ in (200, json("data: {\"type\":\"done\"}\n\n")) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        for try await _ in try client.sendChat(ChatTurn(sessionId: "s1", message: "hi", provider: "p", model: "m",
                                                        reasoning: true, rewindTo: "m7")) {}
        let (_, body) = try #require(StubProtocol.recorded(id).first)
        #expect(bodyJSON(body) == .object([
            "sessionId": .string("s1"), "message": .string("hi"), "provider": .string("p"), "model": .string("m"),
            "reasoning": .bool(true), "rewindTo": .string("m7"),
        ]))
    }

    @Test func alwaysAllowPatchesTheEncodedToolId() async throws {
        let (session, id) = StubProtocol.session { _, _ in (200, json("{}")) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        try await client.alwaysAllowMcpTool("mcp:gh/1:merge")
        let (req, body) = try #require(StubProtocol.recorded(id).first)
        #expect(req.httpMethod == "PATCH")
        #expect(req.url?.absoluteString.hasSuffix("/api/sidecar/api/mcp/tools/mcp:gh%2F1:merge") == true)
        #expect(bodyJSON(body) == .object(["approval": .string("auto")]))
    }

    @Test func providersDecodeCustomAndCompactionFields() throws {
        let p = try JSONDecoder().decode([ProviderInfo].self, from: json(#"""
            [{"id":"custom:x","label":"X","available":false,"custom":true,
              "models":[{"id":"m","capabilities":["chat"],"compactAtTokens":150000}]}]
            """#))
        #expect(p[0].custom == true)
        #expect(p[0].models[0].compactAtTokens == 150_000)
    }
}

@Suite struct McpIssueTests {
    let oauth = McpServer(id: "a", name: "Linear", oauth: true)
    let plain = McpServer(id: "b", name: "Files")

    @Test func signInComesBeforeReconnect() {
        #expect(McpConnectionIssue.of(oauth, status: .init(connected: false))?.fix == .authorize)
        #expect(McpConnectionIssue.of(oauth, status: .init(connected: false, oauth: .init(authorized: false)))?.fix
            == .authorize)
        #expect(McpConnectionIssue.of(oauth, status: .init(connected: false, oauth: .init(authorized: true)))?.fix
            == .reconnect)
        #expect(McpConnectionIssue.of(oauth, status: .init(connected: true, oauth: .init(authorized: true))) == nil)
        #expect(McpConnectionIssue.of(plain, status: .init(connected: false))?.fix == .reconnect)
        #expect(McpConnectionIssue.of(plain, status: .init(connected: true)) == nil)
    }

    @Test func aDisabledServerIsNoIssue() {
        var off = plain
        off.enabled = false
        #expect(McpConnectionIssue.of(off, status: .init(connected: false)) == nil)
    }

    @Test func listsIssuesAndSkipsAServerWhoseStatusFails() async throws {
        let (session, _) = StubProtocol.session { req, _ in
            switch req.url?.path ?? "" {
            case "/api/sidecar/api/mcp/servers":
                return (200, json(#"""
                    [{"id":"a","name":"A","transport":"http","oauth":true,"enabled":true},
                     {"id":"b","name":"B","transport":"stdio","oauth":false,"enabled":true},
                     {"id":"c","name":"C","transport":"stdio","oauth":false,"enabled":false},
                     {"id":"d","name":"D","transport":"stdio","oauth":false,"enabled":true}]
                    """#))
            case "/api/sidecar/api/mcp/servers/a/status":
                return (200, json(#"{"connected":false,"toolCount":0,"oauth":{"registered":true,"authorized":false}}"#))
            case "/api/sidecar/api/mcp/servers/b/status":
                return (200, json(#"{"connected":false,"toolCount":0,"oauth":null}"#))
            default:
                return (500, json(#"{"error":"boom"}"#))
            }
        }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        let issues = try await client.mcpConnectionIssues()
        #expect(issues.map(\.id) == ["a", "b"])
        #expect(issues.map(\.fix) == [.authorize, .reconnect])
    }
}

@Suite struct ArtifactTests {
    @Test func readsAnArtifactAndTreatsA404AsDeleted() async throws {
        let (session, _) = StubProtocol.session { req, _ in
            if req.url?.path.hasSuffix("/gone") == true { return (404, json(#"{"error":"not found"}"#)) }
            return (200, json(#"""
                {"id":"x","title":"Plan","format":"markdown","createdBy":"assistant","untrusted":true,
                 "content":"# Hi","createdAt":"t","updatedAt":"t"}
                """#))
        }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        let a = try await client.artifact(id: "x")
        #expect(a?.title == "Plan")
        #expect(a?.untrusted == true)
        #expect(try await client.artifact(id: "gone") == nil)
    }

    @Test func streamFrames() throws {
        #expect(try ArtifactStreamEvent.decode(json(#"{"type":"updated"}"#)) == .updated)
        #expect(try ArtifactStreamEvent.decode(json(#"{"type":"deleted"}"#)) == .deleted)
        #expect(try ArtifactStreamEvent.decode(json(#"{"type":"hello"}"#)) == .other("hello"))
    }
}

@Suite struct MarkdownBlocksTests {
    @Test func lists() {
        #expect(MarkdownBlock.parse("Steps:\n1. one\n2. two\n   more\n\n- a\n  - b") == [
            .text("Steps:"),
            .list(start: 1, items: [.init("one"), .init("two\nmore")]),
            .list(start: nil, items: [.init("a"), .init("b", depth: 1)]),
        ])
        #expect(MarkdownBlock.parse("3) three") == [.list(start: 3, items: [.init("three")])])
        #expect(MarkdownBlock.parse("- - -") == [.text("- - -")])
    }

    @Test func tables() {
        #expect(MarkdownBlock.parse("| A | B |\n|---|:-:|\n| 1 | 2 |\n| 3 |\nafter") == [
            .table(header: ["A", "B"], rows: [["1", "2"], ["3", ""]]),
            .text("after"),
        ])
        // Without a divider row it's just text.
        #expect(MarkdownBlock.parse("| A | B |\n| 1 | 2 |") == [.text("| A | B |\n| 1 | 2 |")])
    }

    @Test func quotesHoldTheirOwnBlocks() {
        #expect(MarkdownBlock.parse("> # Note\n> - a\nafter") == [
            .quote([.heading("Note"), .list(start: nil, items: [.init("a")])]),
            .text("after"),
        ])
    }

    @Test func imagesAreNeverFetched() {
        #expect(MarkdownBlock.parse("![a chart](https://x/y.png)") == [.image(alt: "a chart")])
        #expect(MarkdownBlock.replacingImages(in: "See ![pic](http://x) here") == "See _Image: pic_ here")
    }
}

@Suite struct WorkspaceMentionTests {
    let id = "3f2a8c1e-0b7d-4e5f-9a6b-1c2d3e4f5a6b"

    @Test func linksKnownIdsByName() {
        #expect(linkWorkspaceMentions("Opened \(id.uppercased()).", names: [id: "Home [net]"])
            == "Opened [Home \\[net\\]](yarvis://workspace/\(id)).")
    }

    @Test func leavesUnknownIdsUrlsAndCodeAlone() {
        let names = [id: "Home"]
        #expect(linkWorkspaceMentions("other 00000000-0000-0000-0000-000000000000", names: names)
            == "other 00000000-0000-0000-0000-000000000000")
        #expect(linkWorkspaceMentions("yarvis://workspace/\(id)", names: names) == "yarvis://workspace/\(id)")
        #expect(linkWorkspaceMentions("`\(id)`", names: names) == "`\(id)`")
        #expect(linkWorkspaceMentions("x-\(id)", names: names) == "x-\(id)")
        #expect(linkWorkspaceMentions("[\(id)](yarvis://workspace/\(id))", names: names)
            == "[\(id)](yarvis://workspace/\(id))")
    }
}

import Foundation
import Testing
@testable import YarvisClient

@Suite struct ServerURLTests {
    @Test func keepsOnlyTheOrigin() throws {
        #expect(try parseServerURL(" https://Yarvis.Example.ts.net/ ").absoluteString == "https://yarvis.example.ts.net")
        #expect(try parseServerURL("https://host:8443").absoluteString == "https://host:8443")
    }

    @Test func allowsPlainHTTPOnlyOnLoopback() throws {
        #expect(try parseServerURL("http://localhost:7878").absoluteString == "http://localhost:7878")
        #expect(try parseServerURL("http://127.0.0.1:7878").host == "127.0.0.1")
        #expect(try parseServerURL("http://[::1]:7878").port == 7878)
        #expect(throws: ServerURLError.insecure) { try parseServerURL("http://mac-mini.ts.net") }
        #expect(throws: ServerURLError.insecure) { try parseServerURL("http://127.0.0.1.evil.com") }
    }

    @Test func refusesWhatIsNotAnOrigin() {
        for bad in ["", "yarvis.example", "ftp://host", "https://host/app", "https://host?x=1", "https://u:p@host"] {
            #expect(throws: ServerURLError.self) { try parseServerURL(bad) }
        }
    }

    @Test func webSocketURLFollowsTheScheme() {
        #expect(base.webSocketURL(path: "/api/events")?.absoluteString == "wss://yarvis.example.ts.net/api/events")
        let local = URL(string: "http://localhost:7878")!
        #expect(local.webSocketURL(path: "/api/pty/x")?.absoluteString == "ws://localhost:7878/api/pty/x")
    }

    @Test func sessionIdsKeepTheirSlashesInsideOneSegment() {
        #expect(encodePathSegment("ws:abc/t1/p2") == "ws:abc%2Ft1%2Fp2")
        #expect(encodePathSegment("a?b#c%d") == "a%3Fb%23c%25d")
    }
}

@Suite struct SignInTests {
    @Test func sendsPassphraseCodeAndDeviceName() async throws {
        let (session, id) = StubProtocol.session { _, _ in
            (200, json(#"{"token":"tok","device":{"deviceId":"d1","name":"Mac","scopes":["read","chat","terminal","approve","admin"],"verifiedAt":5}}"#))
        }
        let signedIn = try await YarvisClient.signIn(
            baseURL: base, SignInRequest(passphrase: "pass", code: "123456", deviceName: "Mac"), session: session)
        #expect(signedIn.token == "tok")
        #expect(signedIn.device.has(.terminal))
        let (req, body) = try #require(StubProtocol.recorded(id).first)
        #expect(req.httpMethod == "POST")
        #expect(req.url?.absoluteString == "https://yarvis.example.ts.net/api/auth/login")
        #expect(req.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(bodyJSON(body) == .object([
            "passphrase": .string("pass"), "code": .string("123456"), "deviceName": .string("Mac"),
        ]))
    }

    @Test func aBackupCodeGoesInItsOwnField() async throws {
        let (session, id) = StubProtocol.session { _, _ in
            (200, json(#"{"token":"t","device":{"deviceId":"d","name":"n","scopes":[]}}"#))
        }
        _ = try await YarvisClient.signIn(
            baseURL: base, SignInRequest(passphrase: "p", code: "abcd-efgh", isBackupCode: true, deviceName: "n"),
            session: session)
        let body = bodyJSON(StubProtocol.recorded(id).first?.1)
        #expect(body?["backupCode"] == .string("abcd-efgh"))
        #expect(body?["code"] == nil)
    }

    @Test func aWrongCodeIsAnErrorNotASignOut() async throws {
        let (session, _) = StubProtocol.session { _, _ in (401, json(#"{"error":"wrong passphrase or code"}"#)) }
        await #expect(throws: YarvisError.unauthorized) {
            try await YarvisClient.signIn(baseURL: base, SignInRequest(passphrase: "p", code: "1", deviceName: "n"),
                                          session: session)
        }
    }

    @Test func unknownScopesAreDropped() throws {
        let d = try JSONDecoder().decode(Device.self, from: json(#"{"deviceId":"d","name":"n","scopes":["read","teleport"]}"#))
        #expect(d.scopes == [.read])
    }
}

/// Records how often the client reported a lost token.
final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func bump() { lock.withLock { n += 1 } }
    var value: Int { lock.withLock { n } }
}

@Suite struct RequestTests {
    @Test func sendsTheBearerTokenAndSidecarPrefix() async throws {
        let (session, id) = StubProtocol.session { _, _ in (200, json("[]")) }
        let client = YarvisClient(baseURL: base, token: "secret-token", session: session)
        _ = try await client.chatSessions()
        let req = try #require(StubProtocol.recorded(id).first?.0)
        #expect(req.url?.path == "/api/sidecar/api/chat/sessions")
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer secret-token")
    }

    @Test func a401SignsOut() async throws {
        let (session, _) = StubProtocol.session { _, _ in (401, json(#"{"error":"sign in first"}"#)) }
        let lost = Counter()
        let client = YarvisClient(baseURL: base, token: "t", session: session, onUnauthorized: { lost.bump() })
        await #expect(throws: YarvisError.unauthorized) { try await client.me() }
        #expect(lost.value == 1)
    }

    @Test func reauthRequiredAsksForACodeAndRetriesOnce() async throws {
        let calls = Counter()
        let (session, id) = StubProtocol.session { req, _ in
            if req.url?.path == "/api/auth/reverify" { return (200, json(#"{"verifiedAt":1}"#)) }
            calls.bump()
            return calls.value == 1
                ? (403, json(#"{"error":"reauth_required"}"#))
                : (200, json("[]"))
        }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        let approvals = try await client.withFreshCode({ "654321" }) { try await client.approvals() }
        #expect(approvals.isEmpty)
        let paths = StubProtocol.recorded(id).map { $0.0.url!.path }
        #expect(paths == ["/api/approvals", "/api/auth/reverify", "/api/approvals"])
        #expect(bodyJSON(StubProtocol.recorded(id)[1].1) == .object(["code": .string("654321")]))
    }

    @Test func cancellingTheCodePromptKeepsTheRefusal() async throws {
        let (session, id) = StubProtocol.session { _, _ in (403, json(#"{"error":"reauth_required"}"#)) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        await #expect(throws: YarvisError.reauthRequired) {
            try await client.withFreshCode({ nil }) { try await client.approvals() }
        }
        #expect(StubProtocol.recorded(id).count == 1)
    }

    @Test func otherErrorsCarryTheServersWords() async throws {
        let (session, _) = StubProtocol.session { _, _ in (409, json(#"{"error":"already answered","detail":"by Phone"}"#)) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        await #expect(throws: YarvisError.http(status: 409, error: "already answered", detail: "by Phone")) {
            try await client.answerApproval(id: "a1", approve: true)
        }
    }

    @Test func coreCommandsPostTheirArguments() async throws {
        let (session, id) = StubProtocol.session { _, _ in (200, json("true")) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        #expect(try await client.ptyExists("ws-claude:w1"))
        let (req, body) = try #require(StubProtocol.recorded(id).first)
        #expect(req.url?.path == "/api/core/pty_exists")
        #expect(bodyJSON(body) == .object(["id": .string("ws-claude:w1")]))
    }

    @Test func answersAPermissionPromptAndReportsOneThatStoppedWaiting() async throws {
        let (session, id) = StubProtocol.session { req, _ in
            req.url!.path.hasSuffix("/gone") ? (410, json(#"{"error":"no longer waiting"}"#)) : (200, json(#"{"ok":true}"#))
        }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        #expect(try await client.answerPermission(id: "p1", .deny(message: "not now")))
        #expect(try await client.answerPermission(id: "gone", .allow) == false)
        let (req, body) = try #require(StubProtocol.recorded(id).first)
        #expect(req.url?.path == "/api/sidecar/api/attention/permissions/p1")
        #expect(bodyJSON(body) == .object(["behavior": .string("deny"), "message": .string("not now")]))
    }

    @Test func answersAQuestionPositionally() async throws {
        let (session, id) = StubProtocol.session { _, _ in (200, json("{}")) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        try await client.answerQuestion(id: "q1", [QuestionAnswer(selected: ["Yes"]), QuestionAnswer(selected: [], text: "Later")])
        let (req, body) = try #require(StubProtocol.recorded(id).first)
        #expect(req.url?.path == "/api/sidecar/api/questions/q1/answer")
        #expect(bodyJSON(body) == .object(["answers": .array([
            .object(["selected": .array([.string("Yes")])]),
            .object(["selected": .array([]), "text": .string("Later")]),
        ])]))
    }
}

@Suite struct DecodingTests {
    @Test func chatMessagesWithToolActivity() throws {
        let messages = try JSONDecoder().decode([ChatMessage].self, from: json("""
        [{"id":"m1","sessionId":"s1","role":"assistant","content":"Done.","metadata":null,
          "toolCalls":[{"id":"c1","name":"recall","args":{"query":"x"},"status":"ok","result":"3 hits","durationMs":12}],
          "createdAt":"2026-11-21T10:00:00.000Z"},
         {"id":"m0","sessionId":"s1","role":"user","content":"hi","toolCalls":null,"createdAt":"2026-11-21T09:59:00.000Z"}]
        """))
        #expect(messages[0].toolCalls?.first?.args?["query"] == .string("x"))
        #expect(messages[1].toolCalls == nil)
    }

    @Test func sessionsIgnoreColumnsTheAppDoesNotUse() throws {
        let s = try JSONDecoder().decode([ChatSession].self, from: json(
            #"[{"id":"s1","title":null,"hidden":false,"createdAt":"a","updatedAt":"b"}]"#))
        #expect(s[0].title == nil)
    }

    @Test func attentionItemsAndTheirStream() throws {
        let row = #"{"id":"i1","seq":4,"source":"claude-hook","sessionKey":"ws-claude:w1","workspaceId":"w1","kind":"permission","title":"api","body":"Bash: ls","status":"pending","navTarget":{"type":"workspace-claude","workspaceId":"w1"},"payload":{"requestId":"r1","toolName":"Bash"},"createdAt":"a","updatedAt":"b","readAt":null,"resolvedAt":null}"#
        guard case .item(let item) = try AttentionStreamEvent.decode(json(#"{"type":"item","item":\#(row)}"#)) else {
            Issue.record("not an item")
            return
        }
        #expect(item.isHookPermission)
        #expect(item.navTarget?["type"] == .string("workspace-claude"))
        #expect(try AttentionStreamEvent.decode(json(#"{"type":"ping"}"#)) == .ping)
    }

    @Test func questionsAndApprovals() throws {
        let q = try JSONDecoder().decode(AgentQuestion.self, from: json("""
        {"id":"q1","sessionKey":null,"workspaceId":null,"context":{"task":"Ship it"},
         "questions":[{"question":"Merge?","options":[{"label":"Yes"},{"label":"No","description":"wait"}],"multiSelect":false}],
         "status":"pending","createdAt":"a","answers":null,"answeredAt":null}
        """))
        #expect(q.questions[0].options?.count == 2)
        let a = try JSONDecoder().decode([Approval].self, from: json(
            #"[{"id":"a1","kind":"git.sign","summary":"Sign a commit","data":{"keyFingerprint":"SHA256:x"},"createdAt":1,"expiresAt":2}]"#))
        #expect(a[0].data["keyFingerprint"] == .string("SHA256:x"))
    }

    @Test func everyChatStreamEvent() throws {
        func d(_ s: String) throws -> ChatStreamEvent { try ChatStreamEvent.decode(json(s)) }
        #expect(try d(#"{"type":"delta","text":"Hi"}"#) == .delta("Hi"))
        #expect(try d(#"{"type":"reasoning","text":"hm"}"#) == .reasoning("hm"))
        #expect(try d(#"{"type":"tool_call","id":"c1","name":"recall","args":{"q":1}}"#)
            == .toolCall(ToolActivity(id: "c1", name: "recall", args: .object(["q": .number(1)]), status: "pending")))
        #expect(try d(#"{"type":"tool_result","id":"c1","status":"denied"}"#)
            == .toolResult(id: "c1", status: "denied", result: nil, durationMs: nil))
        #expect(try d(#"{"type":"tool_approval_request","id":"c2","toolId":"mcp:gh:merge","name":"merge","server":"GitHub","args":{},"reason":"you asked"}"#)
            == .approvalRequest(ToolApprovalRequest(id: "c2", toolId: "mcp:gh:merge", name: "merge", server: "GitHub", args: .object([:]), reason: "you asked")))
        #expect(try d(#"{"type":"error","message":"Turn stopped."}"#) == .error(message: "Turn stopped.", detail: nil))
        #expect(try d(#"{"type":"done","finishReason":"stop","steps":2}"#) == .done)
        #expect(try d(#"{"type":"ping"}"#) == .ping)
        #expect(try d(#"{"type":"later"}"#) == .unknown("later"))
    }
}

@Suite struct ChatStreamTests {
    @Test func sseParserJoinsDataLinesAndSkipsComments() {
        var p = SSEParser()
        #expect(p.feed(line: ": keepalive") == nil)
        #expect(p.feed(line: "data: {\"a\":") == nil)
        #expect(p.feed(line: "data:1}") == nil)
        #expect(p.feed(line: "") == "{\"a\":\n1}")
        #expect(p.feed(line: "") == nil)
    }

    @Test func streamsATurnFromTheSidecar() async throws {
        let sse = [
            #"{"type":"delta","text":"Hel"}"#,
            #"{"type":"tool_call","id":"c1","name":"recall","args":{}}"#,
            #"{"type":"tool_result","id":"c1","status":"ok","result":"none"}"#,
            #"{"type":"delta","text":"lo"}"#,
            #"{"type":"done"}"#,
        ].map { "data: \($0)\r\n\r\n" }.joined()
        let (session, id) = StubProtocol.session { _, _ in (200, json(sse)) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        var events: [ChatStreamEvent] = []
        for try await e in try client.sendChat(ChatTurn(sessionId: "s1", message: "hi", provider: "anthropic", model: "m")) {
            events.append(e)
        }
        #expect(events.first == .delta("Hel"))
        #expect(events.last == .done)
        #expect(events.count == 5)
        let (req, body) = try #require(StubProtocol.recorded(id).first)
        #expect(req.url?.path == "/api/sidecar/api/chat")
        #expect(req.value(forHTTPHeaderField: "Accept") == "text/event-stream")
        #expect(bodyJSON(body) == .object([
            "sessionId": .string("s1"), "message": .string("hi"),
            "provider": .string("anthropic"), "model": .string("m"),
        ]))
    }

    @Test func aRefusedTurnThrowsTheServersError() async throws {
        let (session, _) = StubProtocol.session { _, _ in (400, json(#"{"error":"unknown model","detail":"pick another"}"#)) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        await #expect(throws: YarvisError.http(status: 400, error: "unknown model", detail: "pick another")) {
            for try await _ in try client.sendChat(ChatTurn(sessionId: "s", message: "m", provider: "p", model: "x")) {}
        }
    }

    @Test func picksTheSavedModelOrTheFirstAvailable() {
        let providers = [
            ProviderInfo(id: "bedrock", label: "Bedrock", models: [ModelInfo(id: "b1", capabilities: ["chat"])], available: false),
            ProviderInfo(id: "anthropic", label: "Anthropic", models: [
                ModelInfo(id: "a1", capabilities: ["chat"]), ModelInfo(id: "a2", capabilities: ["chat"]),
            ], available: true),
        ]
        #expect(defaultChatModel(providers, savedProvider: "anthropic", savedModel: "a2")! == ("anthropic", "a2"))
        #expect(defaultChatModel(providers, savedProvider: nil, savedModel: nil)! == ("anthropic", "a1"))
        #expect(defaultChatModel(providers, savedProvider: "gone", savedModel: "a2")! == ("anthropic", "a2"))
        #expect(defaultChatModel(providers, savedProvider: "gone", savedModel: "b1")! == ("anthropic", "a1"))
        #expect(defaultChatModel([], savedProvider: nil, savedModel: nil) == nil)
    }
}

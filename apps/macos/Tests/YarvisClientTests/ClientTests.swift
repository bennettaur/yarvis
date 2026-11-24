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

/// Records what a code prompt was told.
final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [String?] = []
    func add(_ v: String?) { lock.withLock { all.append(v) } }
    var values: [String?] { lock.withLock { all } }
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
        let approvals = try await client.withFreshCode({ _ in "654321" }) { try await client.approvals() }
        #expect(approvals.isEmpty)
        #expect(calls.value == 2)
        let paths = StubProtocol.recorded(id).map { $0.0.url!.path }
        #expect(paths == ["/api/approvals", "/api/auth/reverify", "/api/approvals"])
        #expect(bodyJSON(StubProtocol.recorded(id)[1].1) == .object(["code": .string("654321")]))
    }

    @Test func aWrongCodeAsksAgainWithTheServersWords() async throws {
        let verifies = Counter()
        let done = Counter()
        let (session, _) = StubProtocol.session { req, _ in
            if req.url?.path == "/api/auth/reverify" {
                verifies.bump()
                return verifies.value == 1
                    ? (403, json(#"{"error":"wrong code","detail":"enter the code your authenticator app shows now"}"#))
                    : (200, json(#"{"verifiedAt":1}"#))
            }
            done.bump()
            return done.value == 1 ? (403, json(#"{"error":"reauth_required"}"#)) : (200, json("[]"))
        }
        let lost = Counter()
        let client = YarvisClient(baseURL: base, token: "t", session: session, onUnauthorized: { lost.bump() })
        let refusals = Recorder()
        _ = try await client.withFreshCode({ refusal in
            refusals.add(refusal)
            return "111111"
        }) { try await client.approvals() }
        #expect(refusals.values == [nil, "wrong code: enter the code your authenticator app shows now"])
        #expect(lost.value == 0)
    }

    @Test func cancellingTheSecondPromptKeepsTheRefusal() async throws {
        let (session, id) = StubProtocol.session { req, _ in
            req.url?.path == "/api/auth/reverify"
                ? (403, json(#"{"error":"wrong code"}"#))
                : (403, json(#"{"error":"reauth_required"}"#))
        }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        let prompts = Recorder()
        await #expect(throws: YarvisError.reauthRequired) {
            try await client.withFreshCode({ refusal in
                prompts.add(refusal)
                return refusal == nil ? "111111" : nil
            }) { try await client.approvals() }
        }
        #expect(prompts.values == [nil, "wrong code"])
        #expect(StubProtocol.recorded(id).map { $0.0.url!.path } == ["/api/approvals", "/api/auth/reverify"])
    }

    @Test func otherReverifyRefusalsDontAskAgain() async throws {
        let (session, _) = StubProtocol.session { req, _ in
            req.url?.path == "/api/auth/reverify"
                ? (429, json(#"{"error":"too many tries"}"#))
                : (403, json(#"{"error":"reauth_required"}"#))
        }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        let prompts = Recorder()
        await #expect(throws: YarvisError.http(status: 429, error: "too many tries", detail: nil)) {
            try await client.withFreshCode({ refusal in
                prompts.add(refusal)
                return "111111"
            }) { try await client.approvals() }
        }
        #expect(prompts.values.count == 1)
    }

    @Test func keepsQueryStringsAndEncodesSessionKeys() async throws {
        let (session, id) = StubProtocol.session { _, _ in (200, json("[]")) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        _ = try await client.attentionItems()
        _ = try await client.chatProviders()
        _ = try await client.permissionRequests(sessionKey: "ws:w1/t1 p")
        let urls = StubProtocol.recorded(id).map { $0.0.url! }
        #expect(urls[0].query == "status=pending")
        #expect(urls[1].query == "capability=chat")
        #expect(urls[2].path == "/api/sidecar/api/attention/permissions")
        #expect(urls[2].query == "sessionKey=ws%3Aw1%2Ft1%20p")
    }

    @Test func followsRedirectsOnlyWithinTheServersOrigin() async throws {
        let me = json(#"{"deviceId":"d","name":"n","scopes":[]}"#)
        let (session, id) = StubProtocol.session { req, _ in
            switch req.url?.path {
            case "/api/devices/me": return (307, Data("https://yarvis.example.ts.net/api/devices/me2".utf8))
            case "/api/devices/me2": return (200, me)
            default: return (307, Data("https://elsewhere.example/steal".utf8))
            }
        }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        #expect(try await client.me().deviceId == "d")
        await #expect(throws: YarvisError.self) { try await client.approvals() }
        let hosts = StubProtocol.recorded(id).map { $0.0.url!.host! }
        #expect(hosts.count == 3)
        #expect(hosts.allSatisfy { $0 == "yarvis.example.ts.net" })
    }

    @Test func cancellingTheCodePromptKeepsTheRefusal() async throws {
        let (session, id) = StubProtocol.session { _, _ in (403, json(#"{"error":"reauth_required"}"#)) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        await #expect(throws: YarvisError.reauthRequired) {
            try await client.withFreshCode({ _ in nil }) { try await client.approvals() }
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
        #expect(events == [
            .delta("Hel"),
            .toolCall(ToolActivity(id: "c1", name: "recall", args: .object([:]), status: "pending")),
            .toolResult(id: "c1", status: "ok", result: "none", durationMs: nil),
            .delta("lo"),
            .done,
        ])
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

@Suite struct QuestionLookupTests {
    func item(sessionKey: String?, payload: JSONValue?) -> AttentionItem {
        AttentionItem(id: "i", seq: 1, source: "system", sessionKey: sessionKey, workspaceId: nil, kind: "question",
                      title: "t", body: nil, status: "pending", navTarget: nil, payload: payload,
                      createdAt: "a", updatedAt: "b")
    }

    static let question = #"{"id":"q1","sessionKey":null,"workspaceId":null,"context":{"task":"x"},"questions":[],"status":"STATUS","createdAt":"a"}"#

    @Test func bySessionKey() async throws {
        let (session, id) = StubProtocol.session { _, _ in (200, json("[\(Self.question.replacingOccurrences(of: "STATUS", with: "pending"))]")) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        let found = try await client.questions(for: item(sessionKey: "ws-claude:w1", payload: nil))
        #expect(found.map(\.id) == ["q1"])
        #expect(StubProtocol.recorded(id).first?.0.url?.query == "sessionKey=ws%2Dclaude%3Aw1")
    }

    @Test func byPayloadIdOnlyWhilePending() async throws {
        for (status, expected) in [("pending", ["q1"]), ("answered", [])] {
            let (session, id) = StubProtocol.session { _, _ in (200, json(Self.question.replacingOccurrences(of: "STATUS", with: status))) }
            let client = YarvisClient(baseURL: base, token: "t", session: session)
            let found = try await client.questions(for: item(sessionKey: nil, payload: .object(["questionId": .string("q1")])))
            #expect(found.map(\.id) == expected)
            #expect(StubProtocol.recorded(id).first?.0.url?.path == "/api/sidecar/api/questions/q1")
        }
    }

    @Test func nothingToLookUp() async throws {
        let (session, id) = StubProtocol.session { _, _ in (500, Data()) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        #expect(try await client.questions(for: item(sessionKey: nil, payload: nil)).isEmpty)
        #expect(StubProtocol.recorded(id).isEmpty)
    }
}

@Suite struct StreamAuthTests {
    @Test func a401OnAStreamSignsOut() async throws {
        let (session, _) = StubProtocol.session { _, _ in (401, json(#"{"error":"sign in first"}"#)) }
        let lost = Counter()
        let client = YarvisClient(baseURL: base, token: "t", session: session, onUnauthorized: { lost.bump() })
        await #expect(throws: YarvisError.unauthorized) {
            for try await _ in try client.attentionStream() {}
        }
        #expect(lost.value == 1)
    }

    /// Stop works by cancelling the consumer; the stream must then end
    /// quietly, which is how the app tells a stop from a failure.
    @Test(.timeLimit(.minutes(1))) func cancellingAStreamEndsItWithoutAnError() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NeverEndingSSE.self]
        let client = YarvisClient(baseURL: base, token: "t", session: URLSession(configuration: config))
        let stream = try client.sendChat(ChatTurn(sessionId: "s", message: "m", provider: "p", model: "x"))
        let (firstSeen, seen) = AsyncStream.makeStream(of: Void.self)
        let consumer = Task {
            var events: [ChatStreamEvent] = []
            for try await e in stream {
                events.append(e)
                seen.yield()
            }
            return events
        }
        for await _ in firstSeen { break }
        consumer.cancel()
        #expect(try await consumer.value == [.delta("Hel")])
    }
}

/// Sends one SSE event and then holds the response open.
final class NeverEndingSSE: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "text/event-stream"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("data: {\"type\":\"delta\",\"text\":\"Hel\"}\n\n".utf8))
    }
    override func stopLoading() {}
}

@Suite struct LiveTurnTests {
    @Test func toolResultsUpdateTheirCall() {
        var t = LiveTurn()
        t.apply(.toolCall(ToolActivity(id: "c1", name: "recall", status: "pending")))
        t.apply(.toolResult(id: "c1", status: "ok", result: "3 hits", durationMs: 4))
        t.apply(.toolResult(id: "nope", status: "error", result: nil, durationMs: nil))
        #expect(t.tools == [ToolActivity(id: "c1", name: "recall", status: "ok", result: "3 hits", durationMs: 4)])
    }

    @Test func aSavedTurnKeepsItsReplyUntilReloaded() {
        var t = LiveTurn()
        t.apply(.delta("Hi"))
        t.apply(.approvalRequest(ToolApprovalRequest(id: "a", name: "merge")))
        #expect(t.finish(cancelled: false) == .saved)
        #expect(t.reply == "Hi")
        #expect(t.approvals.isEmpty)
    }

    @Test func aFailedTurnDropsTheReplyAndKeepsTheTools() {
        var t = LiveTurn()
        t.apply(.toolCall(ToolActivity(id: "c1", name: "recall", status: "pending")))
        t.apply(.delta("partial"))
        t.apply(.error(message: "The model refused.", detail: "Try another."))
        #expect(t.finish(cancelled: false) == .failed(TurnFailure(message: "The model refused.", detail: "Try another.")))
        #expect(t.reply.isEmpty)
        #expect(t.tools.count == 1)
    }

    @Test func aStoppedTurnIsANoticeNotAFailure() {
        var t = LiveTurn()
        t.apply(.delta("partial"))
        #expect(t.finish(cancelled: true) == .stopped)
        #expect(t.reply.isEmpty)
    }

    @Test func answeringRemovesFromTheFront() {
        var t = LiveTurn()
        t.apply(.approvalRequest(ToolApprovalRequest(id: "a", name: "x")))
        t.apply(.approvalRequest(ToolApprovalRequest(id: "b", name: "y")))
        t.answered("a")
        #expect(t.approvals.map(\.id) == ["b"])
    }
}

@Suite struct AttentionInboxTests {
    func item(_ id: String, seq: Int64, status: String = "pending") -> AttentionItem {
        AttentionItem(id: id, seq: seq, source: "claude-hook", sessionKey: nil, workspaceId: nil, kind: "idle",
                      title: id, body: nil, status: status, navTarget: nil, payload: nil, createdAt: "a", updatedAt: "b")
    }

    func approval(_ id: String) -> Approval {
        Approval(id: id, kind: "git.sign", summary: "Sign", data: .object([:]), createdAt: 1, expiresAt: 2)
    }

    @Test func whatWasWaitingAtLaunchIsNotNews() {
        var inbox = AttentionInbox()
        #expect(inbox.loadItems([item("a", seq: 1)]).isEmpty)
        #expect(inbox.loadApprovals([approval("g1")]).isEmpty)
        #expect(inbox.loadItems([item("a", seq: 1), item("b", seq: 2)]).map(\.id) == ["b"])
        #expect(inbox.loadApprovals([approval("g1"), approval("g2")]).map(\.id) == ["g2"])
        #expect(inbox.count == 4)
    }

    @Test func aRepromptUpdatesTheRowWithoutNotifyingTwice() {
        var inbox = AttentionInbox()
        _ = inbox.loadItems([])
        #expect(inbox.apply(item("a", seq: 3))?.id == "a")
        var again = item("a", seq: 3)
        again.body = "asked again"
        #expect(inbox.apply(again) == nil)
        #expect(inbox.items.map(\.body) == ["asked again"])
    }

    @Test func aRowThatIsNoLongerPendingLeaves() {
        var inbox = AttentionInbox()
        _ = inbox.loadItems([item("a", seq: 1), item("b", seq: 2)])
        #expect(inbox.apply(item("a", seq: 1, status: "resolved")) == nil)
        #expect(inbox.items.map(\.id) == ["b"])
    }

    @Test func newestFirst() {
        var inbox = AttentionInbox()
        _ = inbox.loadItems([item("a", seq: 1), item("c", seq: 5)])
        _ = inbox.apply(item("b", seq: 3))
        #expect(inbox.items.map(\.id) == ["c", "b", "a"])
    }
}

@Suite struct MarkdownBlockTests {
    @Test func splitsCodeHeadingsAndText() {
        let blocks = MarkdownBlock.parse("""
        ## Plan
        Run **this**:

          ```sh
        make test
        ```
        #notaheading stays text
        """)
        #expect(blocks == [.heading("Plan"), .text("Run **this**:"), .code("make test"), .text("#notaheading stays text")])
    }

    @Test func anUnclosedFenceIsStillCode() {
        #expect(MarkdownBlock.parse("Here:\n```\nlet x") == [.text("Here:"), .code("let x")])
    }
}

@Suite struct SessionIdTests {
    @Test func agentSessionIdsArePrefixed() {
        #expect(WorkspaceSummary.agentSessionId(workspaceId: "w1") == "ws-claude:w1")
    }
}

@Suite struct SignOutAndSessionsTests {
    @Test func revokesThisDeviceAndTakesA401AsDone() async throws {
        for (status, body) in [(200, #"{"revokedAt":5}"#), (401, #"{"error":"sign in first"}"#)] {
            let (session, id) = StubProtocol.session { _, _ in (status, json(body)) }
            let lost = Counter()
            let client = YarvisClient(baseURL: base, token: "tok", session: session, onUnauthorized: { lost.bump() })
            try await client.revokeThisDevice()
            let req = try #require(StubProtocol.recorded(id).first?.0)
            #expect(req.httpMethod == "DELETE")
            #expect(req.url?.path == "/api/devices/me")
            #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
            // The app is signing out on purpose; a 401 isn't the server signing it out.
            #expect(lost.value == 0)
        }
    }

    @Test(.timeLimit(.minutes(1))) func aStalledRevokeGivesUpAtTheDeadline() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NeverEndingSSE.self]
        let client = YarvisClient(baseURL: base, token: "t", session: URLSession(configuration: config))
        await #expect(throws: URLError(.timedOut)) { try await client.revokeThisDevice(timeout: 0.2) }
    }

    @Test func aFailedRevokeIsReported() async throws {
        let (session, _) = StubProtocol.session { _, _ in (503, json(#"{"error":"down"}"#)) }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        await #expect(throws: YarvisError.http(status: 503, error: "down", detail: nil)) {
            try await client.revokeThisDevice()
        }
    }

    @Test func listsSessions() async throws {
        let (session, id) = StubProtocol.session { _, _ in
            (200, json(#"{"sessions":[{"id":"ws-claude:w1","kind":"agent","workspaceId":"w1","cwd":"/srv/w1","harness":{"id":"claude","name":"Claude Code"},"startedAt":1,"running":true,"exitCode":null,"attached":2},{"id":"tab:terminal/t1/p1","kind":"shell","workspaceId":null,"cwd":null,"harness":null,"startedAt":2,"running":false,"exitCode":1,"attached":0}]}"#))
        }
        let client = YarvisClient(baseURL: base, token: "t", session: session)
        let sessions = try await client.ptySessions()
        #expect(StubProtocol.recorded(id).first?.0.url?.path == "/api/pty")
        #expect(sessions == [
            PtySession(id: "ws-claude:w1", kind: "agent", workspaceId: "w1", cwd: "/srv/w1",
                       harness: .init(id: "claude", name: "Claude Code"), startedAt: 1, running: true, attached: 2),
            PtySession(id: "tab:terminal/t1/p1", kind: "shell", startedAt: 2, running: false, exitCode: 1),
        ])
    }

    @Test func listsSessionsWithOptionalFieldsLeftOut() async throws {
        let (session, _) = StubProtocol.session { _, _ in
            (200, json(#"{"sessions":[{"id":"x","kind":"shell","startedAt":1763600000000,"running":true,"attached":1}]}"#))
        }
        let sessions = try await YarvisClient(baseURL: base, token: "t", session: session).ptySessions()
        #expect(sessions == [PtySession(id: "x", kind: "shell", startedAt: 1_763_600_000_000, running: true, attached: 1)])
    }

    @Test func listingWithoutTheTerminalScopeIs403() async throws {
        let (session, _) = StubProtocol.session { _, _ in (403, json(#"{"error":"missing scope"}"#)) }
        await #expect(throws: YarvisError.http(status: 403, error: "missing scope", detail: nil)) {
            try await YarvisClient(baseURL: base, token: "t", session: session).ptySessions()
        }
    }
}

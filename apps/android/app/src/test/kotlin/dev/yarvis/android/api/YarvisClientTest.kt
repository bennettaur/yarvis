package dev.yarvis.android.api

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class YarvisClientTest {
    private val server = MockWebServer()
    private val codes = ArrayDeque<String?>()
    private var prompts = 0
    private lateinit var client: YarvisClient

    @Before
    fun setUp() {
        server.start()
        client = YarvisClient(server.url("/"), "tok-123", testHttp) {
            prompts++
            codes.removeFirstOrNull()
        }
    }

    @After
    fun tearDown() = server.close()

    private fun bodyOf(request: mockwebserver3.RecordedRequest) = Json.parseToJsonElement(request.text).jsonObject

    @Test
    fun `login sends the passphrase, code and device name and decodes the device`() = runTest {
        server.enqueue(
            json(
                200,
                """{"token":"abc","device":{"deviceId":"d1","name":"Pixel","scopes":["read","chat","terminal","approve","admin"],"verifiedAt":1763600000000}}""",
            ),
        )
        val signedIn = AuthClient(server.url("/"), testHttp)
            .login(LoginRequest(passphrase = "correct horse", code = "123456", deviceName = "Pixel"))

        assertEquals("abc", signedIn.token)
        assertEquals("d1", signedIn.device.deviceId)
        assertEquals(1763600000000, signedIn.device.verifiedAt)
        val request = server.next()
        assertEquals("POST", request.method)
        assertEquals("/api/auth/login", request.url.encodedPath)
        assertNull("sign-in sends no token", request.headers["Authorization"])
        // Exactly one second factor: the server rejects a body with both or neither.
        assertEquals(
            Json.parseToJsonElement("""{"passphrase":"correct horse","code":"123456","deviceName":"Pixel"}"""),
            bodyOf(request),
        )
    }

    @Test
    fun `login with a backup code sends backupCode and no code`() = runTest {
        server.enqueue(json(200, """{"token":"abc","device":{"deviceId":"d1","name":"Pixel","scopes":[]}}"""))
        AuthClient(server.url("/"), testHttp)
            .login(LoginRequest(passphrase = "p", backupCode = "abcd-efgh", deviceName = "Pixel"))

        assertEquals(
            Json.parseToJsonElement("""{"passphrase":"p","backupCode":"abcd-efgh","deviceName":"Pixel"}"""),
            bodyOf(server.next()),
        )
    }

    @Test
    fun `a wrong passphrase surfaces the server's error`() = runTest {
        server.enqueue(json(401, """{"error":"wrong passphrase or code"}"""))
        try {
            AuthClient(server.url("/"), testHttp).login(LoginRequest("p", code = "1", deviceName = "x"))
            fail("expected an error")
        } catch (e: UnauthorizedException) {
            assertEquals("wrong passphrase or code", e.error)
        }
    }

    @Test
    fun `status decodes setupRequired`() = runTest {
        server.enqueue(json(200, """{"setupRequired":true,"vault":"absent"}"""))
        assertTrue(AuthClient(server.url("/"), testHttp).status().setupRequired)
        assertEquals("/api/auth/status", server.next().url.encodedPath)
    }

    @Test
    fun `sidecar calls go through the proxy with the bearer token`() = runTest {
        server.enqueue(
            json(
                200,
                """[{"id":"6f1c","title":"Plan the week","createdAt":"2026-11-20T10:00:00.000Z","updatedAt":"2026-11-20T10:05:00.000Z","hidden":false}]""",
            ),
        )
        val sessions = client.sessions()

        assertEquals("Plan the week", sessions.single().title)
        val request = server.next()
        assertEquals("/api/sidecar/api/chat/sessions", request.url.encodedPath)
        assertEquals("Bearer tok-123", request.headers["Authorization"])
    }

    @Test
    fun `messages decode tool activity on the assistant row`() = runTest {
        server.enqueue(
            json(
                200,
                """[
                  {"id":"m1","sessionId":"s1","role":"user","content":"What's on today?","toolCalls":null,"metadata":null,"createdAt":"2026-11-20T10:00:00.000Z"},
                  {"id":"m2","sessionId":"s1","role":"assistant","content":"Two meetings.","metadata":null,"createdAt":"2026-11-20T10:00:05.000Z",
                   "toolCalls":[{"id":"call_1","name":"list_events","server":"calendar","args":{"day":"today"},"status":"ok","result":"2 events","durationMs":412}]}
                ]""",
            ),
        )
        val messages = client.messages("s1")

        assertEquals(listOf("user", "assistant"), messages.map { it.role })
        val call = messages[1].toolCalls!!.single()
        assertEquals("list_events", call.name)
        assertEquals("ok", call.status)
        assertEquals(412L, call.durationMs)
    }

    @Test
    fun `attention items decode with the fields the sidecar adds`() = runTest {
        server.enqueue(
            json(
                200,
                """[{"id":"a1","seq":42,"source":"claude-hook","sessionKey":"ws-1:claude","workspaceId":"w1","kind":"permission",
                   "title":"Claude wants to run Bash","body":"rm -rf build","status":"pending",
                   "navTarget":{"type":"workspace-claude","workspaceId":"w1"},"payload":{"requestId":"r1","toolName":"Bash"},
                   "readAt":null,"resolvedAt":null,"createdAt":"2026-11-20T10:00:00.000Z","updatedAt":"2026-11-20T10:00:00.000Z"},
                  {"id":"a2","seq":41,"source":"system","sessionKey":null,"workspaceId":null,"kind":"question","title":"Claude session",
                   "body":null,"status":"pending","navTarget":null,"payload":{"questionId":"q9"},
                   "createdAt":"2026-11-20T09:00:00.000Z","updatedAt":"2026-11-20T09:00:00.000Z"},
                  {"id":"a3","seq":40,"source":"system","sessionKey":"heads-down:hq1","workspaceId":null,"kind":"permission","title":"Approve a merge",
                   "body":null,"status":"pending","navTarget":{"type":"heads-down"},"payload":null,
                   "createdAt":"2026-11-20T09:00:00.000Z","updatedAt":"2026-11-20T09:00:00.000Z"}]""",
            ),
        )
        val items = client.pendingAttention()

        assertEquals("/api/sidecar/api/attention?status=pending", server.next().target)
        assertTrue(items[0].isClaudePermission)
        assertEquals("q9", items[1].questionId)
        assertNull(items[1].headsDownQuestionId)
        assertEquals("hq1", items[2].headsDownQuestionId)
        assertFalse(items[2].isClaudePermission)
    }

    @Test
    fun `a question item without a session key loads its question by id`() = runTest {
        val item = AttentionItem(
            id = "a2", seq = 1, source = "system", kind = "question", title = "t", status = "pending",
            payload = Json.parseToJsonElement("""{"questionId":"q9"}"""), createdAt = "", updatedAt = "",
        )
        server.enqueue(
            json(
                200,
                """{"id":"q9","sessionKey":null,"workspaceId":null,"context":{"task":"Pick a branch"},
                   "questions":[{"question":"Which one?","options":[{"label":"main"},{"label":"dev"}]}],
                   "status":"pending","answers":null,"answeredAt":null,"createdAt":"2026-11-20T09:00:00.000Z"}""",
            ),
        )
        val questions = client.questionsFor(item)

        assertEquals("/api/sidecar/api/questions/q9", server.next().url.encodedPath)
        assertEquals("Which one?", questions.single().questions.single().question)
    }

    @Test
    fun `permission decisions are tagged by behavior`() = runTest {
        repeat(3) { server.enqueue(json(200, """{"ok":true}""")) }
        assertTrue(client.decidePermission("r1", PermissionDecision.Allow))
        client.decidePermission("r1", PermissionDecision.Deny("not now"))
        client.decidePermission("r1", PermissionDecision.Answer(mapOf("Which branch?" to "main")))

        val allow = server.next()
        assertEquals("/api/sidecar/api/attention/permissions/r1", allow.url.encodedPath)
        assertEquals(Json.parseToJsonElement("""{"behavior":"allow"}"""), bodyOf(allow))
        assertEquals(Json.parseToJsonElement("""{"behavior":"deny","message":"not now"}"""), bodyOf(server.next()))
        assertEquals(
            Json.parseToJsonElement("""{"behavior":"answer","answers":{"Which branch?":"main"}}"""),
            bodyOf(server.next()),
        )
    }

    @Test
    fun `a permission the terminal already settled reports not delivered`() = runTest {
        server.enqueue(json(410, """{"error":"no longer waiting"}"""))
        assertFalse(client.decidePermission("r1", PermissionDecision.Allow))
    }

    @Test
    fun `answering a question sends one answer per question`() = runTest {
        server.enqueue(json(200, """{"id":"q9","context":{"task":"t"},"questions":[],"status":"answered","createdAt":""}"""))
        client.answerQuestion("q9", listOf(QuestionAnswer(listOf("main")), QuestionAnswer(emptyList(), "use dev instead")))

        val request = server.next()
        assertEquals("/api/sidecar/api/questions/q9/answer", request.url.encodedPath)
        assertEquals(
            Json.parseToJsonElement("""{"answers":[{"selected":["main"]},{"selected":[],"text":"use dev instead"}]}"""),
            bodyOf(request),
        )
    }

    @Test
    fun `server approvals decode and are answered with approve`() = runTest {
        server.enqueue(
            json(
                200,
                """[{"id":"ap1","kind":"git.sign","summary":"Sign a git commit or tag with SHA256:abc",
                   "data":{"namespace":"git","keyFingerprint":"SHA256:abc","hashAlgorithm":"sha512"},
                   "createdAt":1763600000000,"expiresAt":1763600060000}]""",
            ),
        )
        server.enqueue(json(200, """{"id":"ap1","approve":true,"answeredBy":"d1"}"""))

        val approval = client.approvals().single()
        client.answerApproval(approval.id, approve = true)

        assertEquals("git.sign", approval.kind)
        assertEquals(1763600060000, approval.expiresAt)
        assertEquals("/api/approvals", server.next().url.encodedPath)
        val answer = server.next()
        assertEquals("/api/approvals/ap1", answer.url.encodedPath)
        assertEquals(Json.parseToJsonElement("""{"approve":true}"""), bodyOf(answer))
    }

    @Test
    fun `reauth_required prompts for a code, reverifies, and retries once`() = runTest {
        server.enqueue(json(403, """{"error":"reauth_required","detail":"confirm with a code first"}"""))
        server.enqueue(json(200, """{"verifiedAt":1763600000000}"""))
        server.enqueue(json(200, """{"delivered":true}"""))
        codes.add("654321")

        client.answerToolApproval("call_1", approved = true)

        assertEquals(1, prompts)
        assertEquals("/api/sidecar/api/chat/approvals/call_1", server.next().url.encodedPath)
        val reverify = server.next()
        assertEquals("/api/auth/reverify", reverify.url.encodedPath)
        assertEquals(Json.parseToJsonElement("""{"code":"654321"}"""), bodyOf(reverify))
        val retry = server.next()
        assertEquals("/api/sidecar/api/chat/approvals/call_1", retry.url.encodedPath)
        assertEquals(Json.parseToJsonElement("""{"approved":true}"""), bodyOf(retry))
    }

    @Test
    fun `a mistyped code asks again`() = runTest {
        server.enqueue(json(403, """{"error":"reauth_required"}"""))
        server.enqueue(json(403, """{"error":"wrong code"}"""))
        server.enqueue(json(200, """{"verifiedAt":1}"""))
        server.enqueue(json(200, """{"id":"ap1","approve":false,"answeredBy":"d1"}"""))
        codes.addAll(listOf("000000", "123456"))

        client.answerApproval("ap1", approve = false)

        assertEquals(2, prompts)
        assertEquals(4, server.requestCount)
    }

    @Test
    fun `closing the code prompt sends nothing more`() = runTest {
        server.enqueue(json(403, """{"error":"reauth_required"}"""))
        codes.add(null)
        try {
            client.answerApproval("ap1", approve = true)
            fail("expected the prompt to be cancelled")
        } catch (_: ReauthCancelledException) {
        }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `a 403 that isn't reauth_required doesn't prompt`() = runTest {
        server.enqueue(json(403, """{"error":"this device doesn't have the approve scope"}"""))
        try {
            client.answerApproval("ap1", approve = true)
            fail("expected an error")
        } catch (e: ApiException) {
            assertEquals(403, e.status)
            assertFalse(e.isReauthRequired)
        }
        assertEquals(0, prompts)
    }

    @Test
    fun `a 401 is an UnauthorizedException`() = runTest {
        server.enqueue(json(401, """{"error":"sign in first"}"""))
        try {
            client.approvals()
            fail("expected an error")
        } catch (e: UnauthorizedException) {
            assertEquals("sign in first", e.error)
        }
    }

    @Test
    fun `a sidecar validation error keeps its message`() = runTest {
        server.enqueue(json(400, """{"error":{"formErrors":[],"fieldErrors":{"answers":["Required"]}}}"""))
        try {
            client.answerQuestion("q9", emptyList())
            fail("expected an error")
        } catch (e: ApiException) {
            assertEquals(400, e.status)
            assertTrue(e.error!!.contains("answers"))
        }
    }

    @Test
    fun `path segments are encoded`() = runTest {
        server.enqueue(json(200, "[]"))
        client.permissions("ws 1/claude")
        assertEquals("/api/sidecar/api/attention/permissions?sessionKey=ws%201%2Fclaude", server.next().target)
    }
}

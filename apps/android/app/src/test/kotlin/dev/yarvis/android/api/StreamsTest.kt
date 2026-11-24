package dev.yarvis.android.api

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class StreamsTest {
    private val server = MockWebServer()
    private lateinit var client: YarvisClient

    @Before
    fun setUp() {
        server.start()
        client = YarvisClient(server.url("/"), "tok", testHttp) { null }
    }

    @After
    fun tearDown() = server.close()

    @Test
    fun `sse data is split on blank lines, multi-line data joined, comments skipped`() {
        val source = Buffer().writeUtf8(": comment\ndata: {\"a\":1}\n\ndata: one\ndata: two\n\nevent: x\ndata:tail")
        val out = mutableListOf<String>()
        readSseData(source) { out += it }
        assertEquals(listOf("{\"a\":1}", "one\ntwo", "tail"), out)
    }

    @Test
    fun `a chat turn streams deltas, tool activity, an approval request and done`() = runTest {
        server.enqueue(
            sse(
                """{"type":"delta","text":"Looking"}""",
                """{"type":"ping"}""",
                """{"type":"tool_call","id":"call_1","name":"create_issue","server":"GitHub","args":{"title":"Bug"}}""",
                """{"type":"tool_approval_request","id":"call_1","toolId":"mcp:gh:create_issue","name":"create_issue","server":"GitHub","args":{"title":"Bug"},"reason":"You asked me to file it"}""",
                """{"type":"tool_result","id":"call_1","status":"ok","result":"#12","durationMs":800}""",
                """{"type":"delta","text":" done."}""",
                """{"type":"done","finishReason":"stop","steps":2}""",
            ),
        )
        val events = client.streamChat(ChatRequest("s1", "File a bug", "anthropic", "claude-sonnet-5-5")).toList()

        assertEquals(
            listOf("delta", "ping", "tool_call", "tool_approval_request", "tool_result", "delta", "done"),
            events.map { it.type },
        )
        assertEquals("You asked me to file it", events[3].reason)
        assertEquals("ok", events[4].status)
        assertEquals(2, events.last().steps)

        val request = server.next()
        assertEquals("/api/sidecar/api/chat", request.url.encodedPath)
        assertEquals("POST", request.method)
        assertEquals(
            Json.parseToJsonElement("""{"sessionId":"s1","message":"File a bug","provider":"anthropic","model":"claude-sonnet-5-5"}"""),
            Json.parseToJsonElement(request.text).jsonObject,
        )
    }

    @Test
    fun `a refused turn throws the sidecar's error`() = runTest {
        server.enqueue(json(503, """{"error":"database not configured"}"""))
        try {
            client.streamChat(ChatRequest("s1", "hi", "p", "m")).toList()
            fail("expected an error")
        } catch (e: ApiException) {
            assertEquals(503, e.status)
            assertEquals("database not configured", e.error)
        }
    }

    @Test
    fun `stopping a turn closes the connection while the reply is still coming`() = runTest {
        // The headers and first frame fit in the first 200 bytes; the rest would take minutes.
        val body = "data: {\"type\":\"delta\",\"text\":\"Hi\"}\n\n" + "data: {\"type\":\"ping\"}\n\n".repeat(50)
        server.enqueue(
            MockResponse.Builder()
                .setHeader("Content-Type", "text/event-stream")
                .body(body)
                .throttleBody(200, 10, TimeUnit.SECONDS)
                .build(),
        )
        val started = System.nanoTime()
        val first = client.streamChat(ChatRequest("s1", "hi", "p", "m")).first()
        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)

        assertEquals("Hi", first.text)
        // Without cancelling the call, the blocked read would hold first() until the 5s read timeout.
        assertTrue("took ${elapsedMs}ms", elapsedMs < 3_000)
    }

    @Test
    fun `the attention stream yields item frames and skips pings`() = runTest {
        server.enqueue(
            sse(
                """{"type":"ping"}""",
                """{"type":"item","item":{"id":"a1","seq":7,"source":"chat-agent","sessionKey":null,"workspaceId":null,"kind":"question","title":"Yarvis","body":"Which repo?","status":"pending","navTarget":{"type":"chat"},"payload":{"questionId":"q1"},"readAt":null,"resolvedAt":null,"createdAt":"2026-11-20T10:00:00.000Z","updatedAt":"2026-11-20T10:00:00.000Z"}}""",
                """{"type":"item","item":{"id":"a1","seq":7,"source":"chat-agent","sessionKey":null,"workspaceId":null,"kind":"question","title":"Yarvis","body":"Which repo?","status":"resolved","navTarget":null,"payload":null,"createdAt":"2026-11-20T10:00:00.000Z","updatedAt":"2026-11-20T10:01:00.000Z"}}""",
            ),
        )
        val items = client.attentionStream().toList()

        assertEquals(listOf("pending", "resolved"), items.map { it.status })
        assertEquals("/api/sidecar/api/attention/stream", server.next().url.encodedPath)
    }
}

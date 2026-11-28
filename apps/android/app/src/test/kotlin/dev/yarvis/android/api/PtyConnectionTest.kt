package dev.yarvis.android.api

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.Buffer
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PtyConnectionTest {
    private val server = MockWebServer()

    /** The first message of each connection, in order. */
    private val hellos = LinkedBlockingQueue<JsonObject>()

    /** Every later message the client sent: text as is, binary as `bin:<size>`. */
    private val sent = LinkedBlockingQueue<String>()

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    /** One connection: after the client's auth message, [script] plays the server's side. */
    private fun connection(onLater: (WebSocket, String) -> Unit = { _, _ -> }, script: (WebSocket) -> Unit) {
        server.enqueue(
            MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                private var helloSeen = false

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (!helloSeen) {
                        helloSeen = true
                        hellos.add(Json.parseToJsonElement(text).jsonObject)
                        script(webSocket)
                    } else {
                        sent.add(text)
                        onLater(webSocket, text)
                    }
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    sent.add("bin:${bytes.size}")
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    // As the real server does, so a client's close() releases the socket.
                    webSocket.close(code, null)
                }
            }).build(),
        )
    }

    private fun frame(offset: Long, text: String): ByteString =
        Buffer().writeLong(offset).writeUtf8(text).readByteString()

    private fun attached(mode: String, start: Long, end: Long, type: String = "attached") =
        """{"type":"$type","clientId":7,"mode":"$mode","requestedOffset":null,"startOffset":$start,"endOffset":$end,
            "lostBytes":0,"cols":80,"rows":24,"owner":7,"exit":null}"""

    private fun connect(
        id: String = "tab:terminal/t1/p1",
        cwd: String? = null,
        mayReconnect: (suspend () -> Boolean)? = null,
        reconnectDelayMs: Long = 0,
        offset: Long? = null,
    ) = OkHttpPtyConnection(
        server.url("/"), "tok-9", testHttp, id, 80, 24,
        cwd = cwd, offset = offset, mayReconnect = mayReconnect, reconnectDelayMs = reconnectDelayMs,
    )

    private fun nextHello(): JsonObject = hellos.poll(5, TimeUnit.SECONDS) ?: error("no auth message arrived")

    /** Updates as comparable strings, since [PtyUpdate.Output] holds a byte array. */
    private fun describe(update: PtyUpdate): String = when (update) {
        is PtyUpdate.Output -> "out:" + update.bytes.decodeToString()
        else -> update.toString()
    }

    private suspend fun run(connection: OkHttpPtyConnection): List<String> {
        connection.start()
        return connection.updates.toList().map(::describe)
    }

    @Test
    fun `attaches with the hello, feeds the snapshot and ends on exit`() = runTest {
        connection { ws ->
            ws.send(attached("snapshot", 0, 5))
            ws.send(frame(0, "hello"))
            ws.send("""{"type":"size","cols":100,"rows":30,"owner":null}""")
            ws.send("""{"type":"exit","code":3}""")
            ws.close(1000, null)
        }
        val id = "ws:0b6a3f1e/t1/p1"

        val updates = run(connect(id = id, cwd = "/w/fix-login"))

        assertEquals(listOf("Reset", "out:hello", "Size(cols=100, rows=30, owner=null)", "Exit(code=3)"), updates)
        val hello = nextHello()
        assertEquals(
            Json.parseToJsonElement("""{"type":"auth","token":"tok-9","cols":80,"rows":24,"cwd":"/w/fix-login"}"""),
            hello,
        )
        val upgrade = server.next()
        assertTrue("the id is one encoded segment", upgrade.url.encodedPath.endsWith("/api/pty/ws:0b6a3f1e%2Ft1%2Fp1"))
        assertEquals(listOf("api", "pty", id), upgrade.url.pathSegments)
        assertFalse(upgrade.target.contains("tok-9"))
        assertNull(upgrade.headers["Authorization"])
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `a reconnect resumes from the last byte and trims the overlap`() = runTest {
        connection { ws ->
            ws.send(attached("snapshot", 0, 6))
            ws.send(frame(0, "abcdef"))
            ws.close(1011, "internal error")
        }
        connection { ws ->
            // A catch-up starting before what was already fed must not repeat it.
            ws.send(attached("resume", 4, 8))
            ws.send(frame(4, "efgh"))
            ws.send(frame(8, "ij"))
            ws.send("""{"type":"exit","code":null}""")
            ws.close(1000, null)
        }

        val updates = run(connect())

        assertEquals(listOf("Reset", "out:abcdef", "Reconnecting", "out:gh", "out:ij", "Exit(code=null)"), updates)
        assertNull("a first attach has nothing to resume", nextHello()["offset"])
        assertEquals(JsonPrimitive(6), nextHello()["offset"])
    }

    @Test
    fun `a snapshot resync clears the screen, and 4401 signs out`() = runTest {
        connection { ws ->
            ws.send(attached("resume", 0, 2))
            ws.send(frame(0, "ab"))
            ws.send(attached("snapshot", 100, 103, type = "resync"))
            ws.send(frame(100, "xyz"))
            ws.close(4401, "device revoked")
        }

        assertEquals(listOf("out:ab", "Reset", "out:xyz", "SignedOut"), run(connect()))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `4403 ends the connection without retrying`() = runTest {
        connection { ws -> ws.close(4403, "missing scope") }

        assertEquals(listOf("Refused(code=4403)"), run(connect()))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `an error message is reported before the 4400 that follows`() = runTest {
        connection { ws ->
            ws.send("""{"type":"error","error":"too many terminals"}""")
            ws.close(4400, "refused")
        }

        assertEquals(listOf("Error(message=too many terminals)", "Refused(code=4400)"), run(connect()))
    }

    @Test
    fun `mayReconnect saying no ends the connection with 1000`() = runTest {
        connection { ws -> ws.close(1011, "internal error") }
        var asked = 0

        val updates = run(connect(id = "ws-claude:0b6a3f1e", mayReconnect = { asked++; false }))

        assertEquals(listOf("Reconnecting", "Refused(code=1000)"), updates)
        assertEquals(1, asked)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `a mayReconnect that throws is asked again, then the reconnect resumes`() = runTest {
        connection { ws ->
            ws.send(attached("snapshot", 0, 3))
            ws.send(frame(0, "abc"))
            ws.close(1011, "internal error")
        }
        connection { ws -> ws.close(4401, "done") }
        var asked = 0

        val updates = run(
            connect(
                mayReconnect = {
                    if (asked++ == 0) throw java.io.IOException("offline")
                    true
                },
            ),
        )

        assertEquals(listOf("Reset", "out:abc", "Reconnecting", "SignedOut"), updates)
        assertEquals(2, asked)
        nextHello()
        assertEquals(JsonPrimitive(3), nextHello()["offset"])
    }

    @Test
    fun `close while waiting to reconnect ends updates and opens no new socket`() = runTest {
        connection { ws -> ws.close(1011, "internal error") }
        // Long enough that only close() can end the wait.
        val connection = connect(reconnectDelayMs = 60_000)
        connection.start()
        connection.updates.first { it == PtyUpdate.Reconnecting }

        connection.close()

        assertEquals(emptyList<PtyUpdate>(), connection.updates.toList())
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `a resize while disconnected goes in the next hello`() = runTest {
        connection { ws -> ws.close(1011, "internal error") }
        connection { ws -> ws.close(4401, "done") }
        val gate = CompletableDeferred<Unit>()
        val connection = connect(mayReconnect = { gate.await(); true })
        connection.start()
        connection.updates.first { it == PtyUpdate.Reconnecting }

        connection.resize(120, 40)
        gate.complete(Unit)

        assertEquals(listOf(PtyUpdate.SignedOut), connection.updates.toList())
        assertEquals(JsonPrimitive(80), nextHello()["cols"])
        val second = nextHello()
        assertEquals(JsonPrimitive(120), second["cols"])
        assertEquals(JsonPrimitive(40), second["rows"])
    }

    @Test
    fun `a dropped transport reconnects`() = runTest {
        // Cancelling on the server drops the TCP connection with no close frame.
        connection { ws -> ws.cancel() }
        connection { ws -> ws.close(4401, "done") }

        assertEquals(listOf("Reconnecting", "SignedOut"), run(connect()))
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `close then a new attach on the same id resumes from the old offset`() = runTest {
        connection { ws ->
            ws.send(attached("snapshot", 0, 2))
            ws.send(frame(0, "ab"))
        }
        connection { ws ->
            ws.send(attached("resume", 1, 4))
            ws.send(frame(1, "bcd"))
            ws.close(4401, "done")
        }
        val first = connect()
        first.start()
        first.updates.first { it is PtyUpdate.Output }
        first.close()
        assertEquals(emptyList<PtyUpdate>(), first.updates.toList())
        assertEquals(2L, first.offset)

        val second = connect(offset = first.offset)
        assertEquals(listOf("out:cd", "SignedOut"), run(second))
        assertEquals(4L, second.offset)
        assertNull(nextHello()["offset"])
        assertEquals(JsonPrimitive(2), nextHello()["offset"])
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `input is split at 64 KiB, and resize and focus go as text`() = runTest {
        connection(onLater = { ws, text -> if ("focus" in text) ws.close(4401, "done") }) { ws ->
            ws.send(attached("snapshot", 0, 1))
            ws.send(frame(0, "$"))
        }
        val connection = connect()
        connection.start()
        connection.updates.first { it is PtyUpdate.Output }

        connection.send(ByteArray(70_000))
        connection.resize(120, 40)
        connection.resize(0, 40)
        connection.focus()
        val rest = connection.updates.toList()

        assertEquals(listOf(PtyUpdate.SignedOut), rest)
        assertEquals(
            listOf("bin:65536", "bin:4464", """{"type":"resize","cols":120,"rows":40}""", """{"type":"focus"}"""),
            List(4) { sent.poll(5, TimeUnit.SECONDS) },
        )
    }

    @Test
    fun `stream state trims frames that are partly or wholly old`() {
        val state = PtyStreamState()
        state.header(snapshot = true)
        assertEquals(true, state.accept(10, "abcd".encodeToByteArray()).first)
        assertEquals(14L, state.nextOffset)

        val partial = state.accept(12, "cdef".encodeToByteArray())
        assertFalse(partial.first)
        assertArrayEquals("ef".encodeToByteArray(), partial.second)

        assertArrayEquals(ByteArray(0), state.accept(11, "bc".encodeToByteArray()).second)
        assertEquals(16L, state.nextOffset)
    }
}

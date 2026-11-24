package dev.yarvis.android.api

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class ServerEventsSocketTest {
    private val server = MockWebServer()

    /** The first message of each connection, in order. */
    private val hellos = LinkedBlockingQueue<JsonObject>()

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    /** One connection: after the client's auth message, [script] plays the server's side. */
    private fun connection(script: (WebSocket) -> Unit) {
        server.enqueue(
            MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    hellos.add(Json.parseToJsonElement(text).jsonObject)
                    script(webSocket)
                }
            }).build(),
        )
    }

    private fun event(seq: Long, kind: String = "approval.requested") =
        """{"type":"event","seq":$seq,"at":1763600000000,"deviceId":null,"kind":"$kind","data":{"id":"ap$seq"}}"""

    private fun socket() = ServerEventsSocket(server.url("/"), "tok-9", testHttp, backoffMs = { 0 })

    private fun nextHello(): JsonObject = hellos.poll(5, TimeUnit.SECONDS) ?: error("no auth message arrived")

    @Test
    fun `reconnects with since and skips events it already has`() = runTest {
        connection { ws ->
            ws.send(event(5))
            ws.close(1011, "internal error")
        }
        connection { ws ->
            // A server replaying from `since` never repeats, but a client must not double-count if one did.
            ws.send(event(5))
            ws.send(event(6, "approval.answered"))
            ws.close(4401, "sign in first")
        }

        val signals = socket().signals().toList()

        assertEquals(
            listOf(5L, 6L),
            signals.filterIsInstance<EventsSignal.Event>().map { it.event.seq },
        )
        assertEquals(EventsSignal.SignedOut, signals.last())
        val first = nextHello()
        assertEquals("auth", (first["type"] as kotlinx.serialization.json.JsonPrimitive).content)
        assertEquals("tok-9", (first["token"] as kotlinx.serialization.json.JsonPrimitive).content)
        assertNull("a first connect asks only for live events", first["since"])
        assertEquals("5", nextHello()["since"].toString())
        assertEquals("/api/events", server.next().url.encodedPath)
    }

    @Test
    fun `the token goes in the first message, never the url`() = runTest {
        connection { ws -> ws.close(4401, "sign in first") }
        socket().signals().toList()

        val upgrade = server.next()
        assertFalse(upgrade.target.contains("tok-9"))
        assertNull(upgrade.headers["Authorization"])
    }

    @Test
    fun `lagged reports a reload and reconnects without since`() = runTest {
        connection { ws ->
            ws.send(event(3))
            ws.send("""{"type":"lagged"}""")
            ws.close(1000, null)
        }
        connection { ws -> ws.close(4403, "missing scope") }

        val signals = socket().signals().toList()

        assertEquals(
            listOf(EventsSignal.Event::class, EventsSignal.Lagged::class, EventsSignal.Refused::class),
            signals.map { it::class },
        )
        assertEquals(EventsSignal.Refused(4403), signals.last())
        nextHello()
        assertNull("after lagged the client starts over", nextHello()["since"])
    }

    @Test
    fun `4400 ends the stream without retrying`() = runTest {
        connection { ws -> ws.close(4400, "bad request") }

        assertEquals(listOf(EventsSignal.Refused(4400)), socket().signals().toList())
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `a dropped connection is retried`() = runTest {
        server.enqueue(MockResponse.Builder().code(502).build())
        connection { ws -> ws.close(4401, "sign in first") }

        assertEquals(listOf(EventsSignal.SignedOut), socket().signals().toList())
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `backoff doubles from one second to thirty`() {
        assertEquals(
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L),
            (1..7).map(ServerEventsSocket::defaultBackoff),
        )
    }
}

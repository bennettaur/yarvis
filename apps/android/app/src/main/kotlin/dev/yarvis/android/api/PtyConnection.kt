package dev.yarvis.android.api

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/**
 * What to feed the terminal for each output frame, and where the stream got to.
 * Each frame starts with the stream offset of its first byte, so bytes already
 * fed are trimmed and a resumed catch-up that overlaps never repeats output.
 */
internal class PtyStreamState(resumeFrom: Long? = null) {
    /** One past the last byte fed: the `offset` a reconnect resumes from. Read from any thread. */
    @Volatile
    var nextOffset: Long? = resumeFrom
        private set
    private var resetBeforeNextFrame = false

    /** An `attached` or `resync` header. A snapshot's catch-up replaces the screen. */
    fun header(snapshot: Boolean) {
        if (snapshot) resetBeforeNextFrame = true
    }

    /** Whether to clear the terminal first, and the bytes to feed. */
    fun accept(offset: Long, bytes: ByteArray): Pair<Boolean, ByteArray> {
        val end = offset + bytes.size
        if (resetBeforeNextFrame) {
            resetBeforeNextFrame = false
            nextOffset = end
            return true to bytes
        }
        val next = nextOffset
        val fresh = if (next != null && offset < next) {
            bytes.copyOfRange(minOf(next - offset, bytes.size.toLong()).toInt(), bytes.size)
        } else {
            bytes
        }
        nextOffset = maxOf(next ?: 0, end)
        return false to fresh
    }
}

/**
 * [PtyConnection] over an OkHttp WebSocket, speaking the `/api/pty/{id}`
 * protocol in `docs/client-server.md`. The token goes in the first message,
 * never the URL. A dropped socket is reconnected after [reconnectDelayMs],
 * resuming from the last byte fed; any 4xxx close ends the connection.
 *
 * [send], [resize] and [focus] may be called from any thread.
 */
class OkHttpPtyConnection(
    baseUrl: HttpUrl,
    private val token: String,
    /** Should have no read timeout and send pings, since a quiet terminal is normal. */
    private val http: OkHttpClient,
    sessionId: String,
    cols: Int,
    rows: Int,
    private val cwd: String? = null,
    /** An earlier connection's [offset], so the first attach resumes instead of replaying the snapshot. */
    offset: Long? = null,
    private val mayReconnect: (suspend () -> Boolean)? = null,
    private val reconnectDelayMs: Long = RECONNECT_DELAY_MS,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) : PtyConnection {
    // Ids hold `/` and `:`; addPathSegment keeps the id one segment by encoding them.
    private val url: HttpUrl = baseUrl.resolve("api/pty/")!!.newBuilder().addPathSegment(sessionId).build()

    // Never drop an update: a lost output frame leaves the screen wrong until the next snapshot.
    private val channel = Channel<PtyUpdate>(Channel.UNLIMITED)
    override val updates: Flow<PtyUpdate> = channel.receiveAsFlow()

    private val stream = PtyStreamState(offset)

    override val offset: Long? get() = stream.nextOffset

    @Volatile private var cols = cols

    @Volatile private var rows = rows

    /** Set only once the hello has gone out, so no input or resize can arrive at the server before it. */
    @Volatile private var socket: WebSocket? = null
    private var job: Job? = null

    init {
        require(sessionId.isNotEmpty() && sessionId != "." && sessionId != "..") { "not a session id: $sessionId" }
    }

    @Synchronized
    override fun start() {
        if (job != null || channel.isClosedForSend) return
        // The channel closes only once run() can no longer send to it, even if the job is cancelled before it starts.
        job = scope.launch { run() }.also { it.invokeOnCompletion { channel.close() } }
    }

    @Synchronized
    override fun close() {
        socket?.close(CLOSE_NORMAL, null)
        socket = null
        val job = job
        if (job != null) job.cancel() else channel.close()
    }

    override fun send(input: ByteArray) {
        val socket = socket ?: return
        var start = 0
        while (start < input.size) {
            val end = minOf(start + MAX_INPUT_BYTES, input.size)
            socket.send(input.toByteString(start, end - start))
            start = end
        }
    }

    override fun resize(cols: Int, rows: Int) {
        if (cols <= 0 || rows <= 0) return
        this.cols = cols
        this.rows = rows
        socket?.send(
            buildJsonObject {
                put("type", "resize")
                put("cols", cols)
                put("rows", rows)
            }.toString(),
        )
    }

    override fun focus() {
        socket?.send(buildJsonObject { put("type", "focus") }.toString())
    }

    private suspend fun run() {
        try {
            while (true) {
                var closeCode: Int? = null
                var exited = false
                connectOnce(stream.nextOffset).collect { frame ->
                    when (frame) {
                        is Frame.Binary -> onOutput(frame.bytes)
                        is Frame.Text -> if (onMessage(frame.text)) exited = true
                        is Frame.Closed -> closeCode = frame.code
                    }
                }
                socket = null
                if (exited) return
                val code = closeCode
                if (code == ServerEventsSocket.CLOSE_UNAUTHORIZED) {
                    channel.send(PtyUpdate.SignedOut)
                    return
                }
                if (code != null && code in 4000..4999) {
                    channel.send(PtyUpdate.Refused(code))
                    return
                }
                channel.send(PtyUpdate.Reconnecting)
                if (!waitToReconnect()) {
                    channel.send(PtyUpdate.Refused(CLOSE_NORMAL))
                    return
                }
            }
        } finally {
            socket = null
        }
    }

    /**
     * Waits out the flat delay: a terminal someone is looking at should come back
     * quickly, and a refusal never retries. False when [mayReconnect] says no.
     * A check that throws (the network is still down) is asked again after another wait.
     */
    private suspend fun waitToReconnect(): Boolean {
        while (true) {
            delay(reconnectDelayMs)
            val check = mayReconnect ?: return true
            try {
                return check()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
    }

    private suspend fun onOutput(frame: ByteString) {
        if (frame.size < 8) return
        val raw = frame.toByteArray()
        var offset = 0L
        for (i in 0 until 8) offset = (offset shl 8) or (raw[i].toLong() and 0xff)
        val (reset, bytes) = stream.accept(offset, raw.copyOfRange(8, raw.size))
        if (reset) channel.send(PtyUpdate.Reset)
        if (bytes.isNotEmpty()) channel.send(PtyUpdate.Output(bytes))
    }

    /** Handles one server message. True for `exit`, after which the connection ends. */
    private suspend fun onMessage(text: String): Boolean {
        val message = runCatching { YarvisJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return false
        fun field(key: String) = message[key] as? JsonPrimitive
        when (field("type")?.contentOrNull) {
            "attached", "resync" -> stream.header(snapshot = field("mode")?.contentOrNull != "resume")
            "size" -> channel.send(
                PtyUpdate.Size(field("cols")?.intOrNull ?: 0, field("rows")?.intOrNull ?: 0, field("owner")?.longOrNull),
            )
            "exit" -> {
                channel.send(PtyUpdate.Exit(field("code")?.intOrNull))
                return true
            }
            "error" -> channel.send(PtyUpdate.Error(field("error")?.contentOrNull ?: "The terminal refused to attach."))
        }
        return false
    }

    private sealed interface Frame {
        class Text(val text: String) : Frame
        class Binary(val bytes: ByteString) : Frame

        /** [code] is null for a dropped connection. */
        class Closed(val code: Int?) : Frame
    }

    private fun connectOnce(offset: Long?): Flow<Frame> = callbackFlow {
        val ws = http.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send(hello(offset).toString())
                    socket = webSocket
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    trySend(Frame.Text(text))
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    trySend(Frame.Binary(bytes))
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    // Answer the server's close so the socket is released.
                    webSocket.close(code, null)
                    trySend(Frame.Closed(code))
                    close()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    trySend(Frame.Closed(code))
                    close()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    trySend(Frame.Closed(null))
                    close()
                }
            },
        )
        awaitClose { ws.cancel() }
    }.buffer(Channel.UNLIMITED)

    private fun hello(offset: Long?): JsonObject = buildJsonObject {
        put("type", "auth")
        put("token", token)
        put("cols", cols)
        put("rows", rows)
        if (offset != null) put("offset", offset)
        if (cwd != null) put("cwd", cwd)
    }

    companion object {
        const val RECONNECT_DELAY_MS = 1_000L

        /** The server closes a socket that sends more than this in one message. */
        const val MAX_INPUT_BYTES = 64 * 1024
        private const val CLOSE_NORMAL = 1000
    }
}

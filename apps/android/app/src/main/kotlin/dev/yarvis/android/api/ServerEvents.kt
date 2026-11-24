package dev.yarvis.android.api

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

sealed interface EventsSignal {
    data class Event(val event: ServerEvent) : EventsSignal

    /** Events were missed. Reload what's on screen; the socket reconnects without `since`. */
    data object Lagged : EventsSignal

    /** 4401: the token is no good. Sign in again. The flow ends. */
    data object SignedOut : EventsSignal

    /** 4403 or 4400: retrying won't help. The flow ends. */
    data class Refused(val code: Int) : EventsSignal
}

/**
 * The server's `/api/events` WebSocket, reconnected until the server closes it
 * with 4401, 4403 or 4400. The token goes in the first message, never the URL. A reconnect
 * sends `since` with the last seq seen, so nothing is missed or repeated.
 *
 * [backoffMs] gives the wait before reconnect attempt n (1-based).
 */
class ServerEventsSocket(
    baseUrl: HttpUrl,
    private val token: String,
    private val http: OkHttpClient,
    private val backoffMs: (attempt: Int) -> Long = ::defaultBackoff,
) {
    private val url = baseUrl.resolve("api/events")!!

    fun signals(): Flow<EventsSignal> = flow {
        var lastSeq: Long? = null
        var attempt = 0
        while (true) {
            var closed: Frame.Closed? = null
            connectOnce(lastSeq).collect { frame ->
                if (frame is Frame.Closed) {
                    closed = frame
                    return@collect
                }
                when (val signal = parse((frame as Frame.Text).text)) {
                    is EventsSignal.Event -> {
                        // As the web client does, the backoff resets on the first event, not on
                        // connect, so a server that accepts and then drops at once is still backed off.
                        attempt = 0
                        val last = lastSeq
                        // Skips anything at or before what was seen, so a resumed replay never repeats.
                        if (last == null || signal.event.seq > last) {
                            lastSeq = signal.event.seq
                            emit(signal)
                        }
                    }
                    EventsSignal.Lagged -> {
                        lastSeq = null
                        emit(signal)
                    }
                    else -> Unit
                }
            }
            when (val code = closed?.code) {
                CLOSE_UNAUTHORIZED -> {
                    emit(EventsSignal.SignedOut)
                    return@flow
                }
                CLOSE_FORBIDDEN, CLOSE_BAD_REQUEST -> {
                    emit(EventsSignal.Refused(code))
                    return@flow
                }
            }
            attempt++
            delay(backoffMs(attempt))
        }
    }

    /** An event or `lagged`, or null for anything else. */
    private fun parse(text: String): EventsSignal? {
        val message = runCatching { YarvisJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return null
        return when (message["type"]?.jsonPrimitive?.contentOrNull) {
            "event" -> runCatching { YarvisJson.decodeFromJsonElement(ServerEvent.serializer(), message) }
                .getOrNull()?.let { EventsSignal.Event(it) }
            "lagged" -> EventsSignal.Lagged
            else -> null
        }
    }

    private sealed interface Frame {
        data class Text(val text: String) : Frame

        /** [code] is null for a dropped connection. */
        data class Closed(val code: Int?) : Frame
    }

    private fun connectOnce(since: Long?): Flow<Frame> = callbackFlow {
        val hello: JsonObject = buildJsonObject {
            put("type", "auth")
            put("token", token)
            if (since != null) put("since", JsonPrimitive(since))
        }
        val socket = http.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send(hello.toString())
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    trySend(Frame.Text(text))
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
        awaitClose { socket.cancel() }
    }
        // Never drop a frame: a lost event is gone for good once a later seq moves `lastSeq` past it.
        .buffer(Channel.UNLIMITED)

    companion object {
        const val CLOSE_UNAUTHORIZED = 4401
        const val CLOSE_FORBIDDEN = 4403
        const val CLOSE_BAD_REQUEST = 4400

        /** 1s doubling to 30s, as the web client does. */
        fun defaultBackoff(attempt: Int): Long = (1000L shl (attempt - 1).coerceIn(0, 5)).coerceAtMost(30_000L)
    }
}

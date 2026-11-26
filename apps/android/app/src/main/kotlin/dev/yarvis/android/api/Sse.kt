package dev.yarvis.android.api

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import okhttp3.Call
import okio.BufferedSource

/**
 * Reads server-sent events and passes each event's data to [onData]. The
 * sidecar writes one `data:` line per event; multi-line data is joined with
 * newlines as the SSE spec says. Returns when the stream ends.
 */
internal inline fun readSseData(source: BufferedSource, onData: (String) -> Unit) {
    val data = StringBuilder()
    var hasData = false
    while (true) {
        val line = source.readUtf8Line() ?: break
        if (line.isEmpty()) {
            if (hasData) onData(data.toString())
            data.clear()
            hasData = false
            continue
        }
        if (!line.startsWith("data:")) continue
        if (hasData) data.append('\n')
        data.append(line.removePrefix("data:").removePrefix(" "))
        hasData = true
    }
    if (hasData) onData(data.toString())
}

/**
 * The data of each event on [call]'s response. Cancelling the collector cancels
 * the call, which is how a chat turn is stopped: the sidecar treats the
 * dropped connection as the user's stop.
 */
internal fun sseFlow(call: Call): Flow<String> = callbackFlow {
    val response = call.await()
    if (!response.isSuccessful) {
        val error = response.toApiException()
        response.close()
        throw error
    }
    // ATOMIC: the reader must start even if the flow is cancelled first, so `use` closes the body.
    launch(Dispatchers.IO, start = CoroutineStart.ATOMIC) {
        try {
            response.body.source().use { source -> readSseData(source) { send(it) } }
            close()
        } catch (e: Exception) {
            close(e)
        }
    }
    // Cancelling the call unblocks the reader, whose `use` closes the body.
    // Closing it here as well would race that read on another thread.
    awaitClose { call.cancel() }
}

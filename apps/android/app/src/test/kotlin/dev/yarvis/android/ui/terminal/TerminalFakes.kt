package dev.yarvis.android.ui.terminal

import dev.yarvis.android.api.PtyApi
import dev.yarvis.android.api.PtyConnection
import dev.yarvis.android.api.PtySession
import dev.yarvis.android.api.PtyUpdate
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.consumeAsFlow

class FakePtyConnection(
    val sessionId: String,
    val cols: Int,
    val rows: Int,
    val cwd: String?,
    val startOffset: Long?,
    val mayReconnect: (suspend () -> Boolean)?,
) : PtyConnection {
    override var offset: Long? = null

    private val channel = Channel<PtyUpdate>(Channel.UNLIMITED)
    override val updates: Flow<PtyUpdate> = channel.consumeAsFlow()

    var started = false
    var closed = false
    var focusCount = 0
    val sent = mutableListOf<String>()
    val resizes = mutableListOf<Pair<Int, Int>>()

    fun emit(update: PtyUpdate) {
        channel.trySend(update)
    }

    /** Ends the connection, as the client does after an exit or a refusal. */
    fun end() {
        channel.close()
    }

    override fun start() {
        started = true
    }

    override fun close() {
        closed = true
        channel.close()
    }

    override fun send(input: ByteArray) {
        sent += input.toString(Charsets.UTF_8)
    }

    override fun resize(cols: Int, rows: Int) {
        resizes += cols to rows
    }

    override fun focus() {
        focusCount++
    }
}

class FakePtyApi : PtyApi {
    var sessions = mutableListOf<PtySession>()
    var exists = true
    var listError: Exception? = null
    val killed = mutableListOf<String>()
    val connections = mutableListOf<FakePtyConnection>()
    var existsError: Exception? = null
    val existsAsked = mutableListOf<String>()

    val last: FakePtyConnection get() = connections.last()

    override suspend fun ptySessions(): List<PtySession> {
        listError?.let { throw it }
        return sessions.toList()
    }

    override suspend fun ptyKill(id: String) {
        killed += id
        sessions.removeAll { it.id == id }
    }

    override suspend fun ptyExists(id: String): Boolean {
        existsAsked += id
        existsError?.let { throw it }
        return exists
    }

    override fun attachPty(
        sessionId: String,
        cols: Int,
        rows: Int,
        cwd: String?,
        offset: Long?,
        mayReconnect: (suspend () -> Boolean)?,
    ): PtyConnection = FakePtyConnection(sessionId, cols, rows, cwd, offset, mayReconnect).also { connections += it }
}

class RecordingSink : TerminalSink {
    val calls = mutableListOf<String>()

    override fun reset() {
        calls += "reset"
    }

    override fun write(bytes: ByteArray) {
        calls += bytes.toString(Charsets.UTF_8)
    }
}

fun session(id: String, kind: String = "shell", running: Boolean = true, cwd: String? = null, workspaceId: String? = null) =
    PtySession(id = id, kind = kind, running = running, cwd = cwd, workspaceId = workspaceId)

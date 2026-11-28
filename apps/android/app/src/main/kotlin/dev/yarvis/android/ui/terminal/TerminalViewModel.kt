package dev.yarvis.android.ui.terminal

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.yarvis.android.api.PtyApi
import dev.yarvis.android.api.PtyConnection
import dev.yarvis.android.api.PtyIds
import dev.yarvis.android.api.PtyUpdate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface TerminalStatus {
    data object Connecting : TerminalStatus
    data object Live : TerminalStatus
    data object Reconnecting : TerminalStatus
    data class Exited(val code: Int?) : TerminalStatus

    /** The server refused the session, or the connection failed for good. */
    data class Failed(val message: String) : TerminalStatus
    data object SignedOut : TerminalStatus
}

data class TerminalState(
    val status: TerminalStatus = TerminalStatus.Connecting,
    val fontSize: Int = DEFAULT_FONT_SIZE,
    val ctrlArmed: Boolean = false,
    /** Agent and review sessions are started by the sidecar only, so they get no "new shell". */
    val canStartNewShell: Boolean = false,
)

const val DEFAULT_FONT_SIZE = 12
const val MIN_FONT_SIZE = 8
const val MAX_FONT_SIZE = 24

/**
 * Owns the [PtyConnection] so a rotation doesn't reconnect.
 *
 * The page is recreated with the activity, and a new xterm starts blank. Rather
 * than reattach in snapshot mode, the last [REPLAY_CAPACITY] bytes of output are
 * kept here and replayed into the new page ([attachSink]). That needs no round
 * trip, and it also works after the shell exited, where reattaching to a shell
 * id would spawn a new shell.
 *
 * The attach waits for the page's first viewport, so the server never sizes the
 * PTY to a guessed 80x24 that the phone then has to undo.
 */
class TerminalViewModel(
    private val pty: PtyApi,
    private val sessionId: String,
    private val cwd: String?,
) : ViewModel() {
    private val isAgent = PtyIds.isAgentOrReview(sessionId)
    private val _state = MutableStateFlow(TerminalState())
    val state: StateFlow<TerminalState> = _state.asStateFlow()

    private val replay = ReplayBuffer()
    private var sink: TerminalSink? = null
    private var connection: PtyConnection? = null
    private var collector: Job? = null
    private var viewport: Pair<Int, Int>? = null
    private var appCursor = false
    private var refusal: String? = null

    // Typing takes the size over on the server anyway; the explicit focus makes it immediate.
    private var focused = false

    /** Output since the last reset is replayed into [sink] before anything live. */
    fun attachSink(sink: TerminalSink) {
        this.sink = sink
        // A fresh page starts in normal cursor mode and reports only changes from it.
        appCursor = false
        sink.reset()
        if (replay.size > 0) sink.write(replay.snapshot())
    }

    fun detachSink(sink: TerminalSink) {
        if (this.sink === sink) this.sink = null
    }

    fun onViewport(cols: Int, rows: Int) {
        if (cols <= 0 || rows <= 0) return
        viewport = cols to rows
        when {
            connection != null -> connection?.resize(cols, rows)
            collector?.isActive != true -> connect()
        }
    }

    fun onTap() {
        connection?.focus()
        focused = true
    }

    /** Text from the keyboard, as xterm reports it. */
    fun onInput(text: String) {
        val armed = _state.value.ctrlArmed
        if (armed) _state.update { it.copy(ctrlArmed = false) }
        send(if (armed) TerminalKeys.withCtrl(text) else text)
    }

    /** xterm's binary data: one char per byte, used for some mouse reports. */
    fun onBinary(data: String) {
        val conn = connection ?: return
        conn.send(ByteArray(data.length) { data[it].code.toByte() })
    }

    fun onModes(appCursor: Boolean) {
        this.appCursor = appCursor
    }

    fun press(key: ExtraKey) {
        val armed = _state.value.ctrlArmed
        if (armed) _state.update { it.copy(ctrlArmed = false) }
        send(TerminalKeys.encode(key, armed, appCursor))
    }

    fun toggleCtrl() = _state.update { it.copy(ctrlArmed = !it.ctrlArmed) }

    fun changeFontSize(delta: Int) =
        _state.update { it.copy(fontSize = (it.fontSize + delta).coerceIn(MIN_FONT_SIZE, MAX_FONT_SIZE)) }

    /** Attaching to an exited shell's id starts a new shell there. */
    fun startNewShell() {
        if (isAgent || _state.value.status !is TerminalStatus.Exited) return
        if (viewport == null) return
        connection?.close()
        connection = null
        clearScreen()
        connect()
    }

    private fun connect() {
        collector?.cancel()
        refusal = null
        _state.update { it.copy(status = TerminalStatus.Connecting, canStartNewShell = false) }
        focused = false
        collector = viewModelScope.launch {
            try {
                // Attaching to a dead agent id would spawn a plain shell under it.
                if (isAgent && !pty.ptyExists(sessionId)) {
                    setStatus(TerminalStatus.Failed(refusedMessage(1000)))
                    return@launch
                }
                val mayReconnect: (suspend () -> Boolean)? = if (isAgent) suspend { pty.ptyExists(sessionId) } else null
                // The viewport read now, since it may have changed while the check ran.
                val (cols, rows) = viewport ?: return@launch
                val conn = pty.attachPty(sessionId, cols, rows, cwd, mayReconnect)
                connection = conn
                // Undispatched so the collector is subscribed before start() sends the first catch-up.
                val updates = launch(start = CoroutineStart.UNDISPATCHED) { conn.updates.collect(::handle) }
                conn.start()
                updates.join()
                if (!isFinal(_state.value.status)) setStatus(TerminalStatus.Failed("The connection closed."))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                setStatus(TerminalStatus.Failed("Couldn't connect: ${e.message}"))
            }
        }
    }

    private fun handle(update: PtyUpdate) {
        when (update) {
            PtyUpdate.Reset -> {
                clearScreen()
                setStatus(TerminalStatus.Live)
            }
            is PtyUpdate.Output -> {
                replay.append(update.bytes)
                sink?.write(update.bytes)
                setStatus(TerminalStatus.Live)
            }
            is PtyUpdate.Size -> setStatus(TerminalStatus.Live)
            PtyUpdate.Reconnecting -> {
                focused = false
                setStatus(TerminalStatus.Reconnecting)
            }
            is PtyUpdate.Exit -> _state.update {
                it.copy(status = TerminalStatus.Exited(update.code), canStartNewShell = !isAgent)
            }
            is PtyUpdate.Error -> refusal = update.message
            PtyUpdate.SignedOut -> setStatus(TerminalStatus.SignedOut)
            is PtyUpdate.Refused -> setStatus(TerminalStatus.Failed(refusal ?: refusedMessage(update.code)))
        }
    }

    private fun send(text: String) {
        val conn = connection ?: return
        if (text.isEmpty()) return
        if (!focused) {
            conn.focus()
            focused = true
        }
        conn.send(text.toByteArray(Charsets.UTF_8))
    }

    private fun clearScreen() {
        replay.clear()
        sink?.reset()
    }

    private fun setStatus(status: TerminalStatus) = _state.update { it.copy(status = status) }

    private fun isFinal(status: TerminalStatus) =
        status is TerminalStatus.Exited || status is TerminalStatus.Failed || status == TerminalStatus.SignedOut

    private fun refusedMessage(code: Int) = when (code) {
        4403 -> "This device isn't allowed to use terminals."
        1000 -> "This session is no longer running."
        else -> "The server refused this terminal ($code)."
    }

    override fun onCleared() {
        connection?.close()
        connection = null
    }
}

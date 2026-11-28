package dev.yarvis.android.ui.terminal

import android.annotation.SuppressLint
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.yarvis.android.api.PtyApi
import dev.yarvis.android.api.PtyConnection
import dev.yarvis.android.api.PtyIds
import dev.yarvis.android.api.PtyUpdate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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

private const val ESC = '\u001b'

/** The same grace AppContainer gives the event stream, so a quick app switch keeps the socket. */
const val BACKGROUND_GRACE_MS = 10 * 60 * 1000L

/** `mayReconnect` said no: the session is gone. */
private const val GONE = 1000

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
 *
 * Once the app has been in the background for [backgroundGraceMs] the socket is
 * closed, and it reattaches from the same offset when the app comes back, so
 * the replay buffer stays valid. A session that ended
 * meanwhile shows as exited rather than spawning a new shell.
 *
 * An agent id is checked with `ptyExists` before each attach, but the agent can
 * still exit between the check and the attach. The server then spawns a plain
 * shell under `ws-claude:`, since unlike `review-claude:` it doesn't refuse that.
 */
class TerminalViewModel(
    private val pty: PtyApi,
    private val sessionId: String,
    private val cwd: String?,
    // The process lifecycle, which outlives every activity, so there is nothing to leak.
    @SuppressLint("StaticFieldLeak") private val appLifecycle: Lifecycle? = null,
    private val backgroundGraceMs: Long = BACKGROUND_GRACE_MS,
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

    // Only a tap takes the PTY size over. Typing does it on the server, which
    // also leaves out the automatic replies a terminal sends, so input never does.
    private var tapped = false
    private var refocusPending = false

    private var backgroundClose: Job? = null
    private var closedInBackground = false

    // Where the connection closed in the background had got to, so the reattach resumes rather than replays.
    private var resumeOffset: Long? = null

    private val lifecycleObserver = object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) = onAppStarted()
        override fun onStop(owner: LifecycleOwner) = onAppStopped()
    }

    init {
        appLifecycle?.addObserver(lifecycleObserver)
    }

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
        val conn = connection
        when {
            conn != null -> conn.resize(cols, rows)
            // Only the first viewport attaches; after a failure, Retry does.
            collector == null && !closedInBackground -> connect(checkFirst = isAgent)
        }
    }

    fun onTap() {
        tapped = true
        connection?.focus()
    }

    /** Text from the keyboard, as xterm reports it. */
    fun onInput(text: String) {
        // Replies the terminal sends on its own start with ESC; they must not use up Ctrl.
        if (text.firstOrNull() == ESC) return send(text)
        send(if (consumeCtrl()) TerminalKeys.withCtrl(text) else text)
    }

    /** xterm's binary data: one char per byte, used for some mouse reports. */
    fun onBinary(data: String) {
        val conn = connection ?: return
        conn.send(ByteArray(data.length) { data[it].code.toByte() })
    }

    fun onModes(appCursor: Boolean) {
        this.appCursor = appCursor
    }

    fun press(key: ExtraKey) = send(TerminalKeys.encode(key, consumeCtrl(), appCursor))

    fun toggleCtrl() = _state.update { it.copy(ctrlArmed = !it.ctrlArmed) }

    fun changeFontSize(delta: Int) =
        _state.update { it.copy(fontSize = (it.fontSize + delta).coerceIn(MIN_FONT_SIZE, MAX_FONT_SIZE)) }

    /** Attaching to an exited shell's id starts a new shell there. */
    fun startNewShell() {
        if (isAgent || _state.value.status !is TerminalStatus.Exited || viewport == null) return
        closeConnection()
        clearScreen()
        connect(checkFirst = false)
    }

    fun retry() {
        if (_state.value.status !is TerminalStatus.Failed || viewport == null) return
        closeConnection()
        connect(checkFirst = isAgent)
    }

    fun onAppStopped() {
        backgroundClose?.cancel()
        backgroundClose = viewModelScope.launch {
            delay(backgroundGraceMs)
            val conn = connection
            if (conn != null && !isFinal(_state.value.status)) {
                resumeOffset = conn.offset
                closeConnection()
                closedInBackground = true
            }
        }
    }

    fun onAppStarted() {
        backgroundClose?.cancel()
        backgroundClose = null
        if (!closedInBackground) return
        closedInBackground = false
        // A shell that exited while we were away would be respawned by a blind attach.
        if (viewport != null) connect(checkFirst = true)
    }

    private fun consumeCtrl(): Boolean {
        val armed = _state.value.ctrlArmed
        if (armed) _state.update { it.copy(ctrlArmed = false) }
        return armed
    }

    /** [checkFirst] makes sure the session still runs, so the attach can't spawn a shell in its place. */
    private fun connect(checkFirst: Boolean) {
        collector?.cancel()
        refusal = null
        refocusPending = tapped
        _state.update { it.copy(status = TerminalStatus.Connecting, canStartNewShell = false) }
        collector = viewModelScope.launch {
            try {
                if (checkFirst && !pty.ptyExists(sessionId)) {
                    gone()
                    return@launch
                }
                // The viewport read now, since it may have changed while the check ran.
                val (cols, rows) = viewport ?: return@launch
                val offset = resumeOffset
                resumeOffset = null
                val conn = pty.attachPty(sessionId, cols, rows, cwd, offset = offset, mayReconnect = { pty.ptyExists(sessionId) })
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
                live()
            }
            is PtyUpdate.Output -> {
                replay.append(update.bytes)
                sink?.write(update.bytes)
                live()
            }
            is PtyUpdate.Size -> live()
            PtyUpdate.Reconnecting -> {
                refocusPending = tapped
                setStatus(TerminalStatus.Reconnecting)
            }
            is PtyUpdate.Exit -> exited(update.code)
            is PtyUpdate.Error -> refusal = update.message
            PtyUpdate.SignedOut -> setStatus(TerminalStatus.SignedOut)
            is PtyUpdate.Refused ->
                if (update.code == GONE && refusal == null) gone() else setStatus(TerminalStatus.Failed(refusal ?: refusedMessage(update.code)))
        }
    }

    // The first frame after an attach or a reconnect: give the size back to the phone if the user had taken it.
    private fun live() {
        if (refocusPending) {
            refocusPending = false
            connection?.focus()
        }
        setStatus(TerminalStatus.Live)
    }

    private fun exited(code: Int?) =
        _state.update { it.copy(status = TerminalStatus.Exited(code), canStartNewShell = !isAgent) }

    /** The session ended without us seeing its exit. A shell can be started again; an agent can't. */
    private fun gone() = if (isAgent) setStatus(TerminalStatus.Failed(refusedMessage(GONE))) else exited(null)

    private fun send(text: String) {
        val conn = connection ?: return
        if (text.isNotEmpty()) conn.send(text.toByteArray(Charsets.UTF_8))
    }

    private fun closeConnection() {
        collector?.cancel()
        collector = null
        connection?.close()
        connection = null
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
        GONE -> "This session is no longer running."
        else -> "The server refused this terminal ($code)."
    }

    override fun onCleared() {
        appLifecycle?.removeObserver(lifecycleObserver)
        closeConnection()
    }
}

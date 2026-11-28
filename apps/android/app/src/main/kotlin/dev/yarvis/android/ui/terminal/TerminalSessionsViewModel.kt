package dev.yarvis.android.ui.terminal

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.yarvis.android.api.PtyApi
import dev.yarvis.android.api.PtyIds
import dev.yarvis.android.api.PtySession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class TerminalSessionsState(
    val sessions: List<PtySession> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
)

/**
 * The Terminal tab's list: the web Terminal page's own panes, oldest first.
 * Agent sessions and workspace shells belong to their workspace's page, as on
 * the web. The screen refreshes it on resume, so nothing loads until it's shown.
 */
class TerminalSessionsViewModel(private val pty: PtyApi) : ViewModel() {
    private val _state = MutableStateFlow(TerminalSessionsState())
    val state: StateFlow<TerminalSessionsState> = _state.asStateFlow()

    private var load: Job? = null

    /** A newer refresh replaces one still running, so an older answer can't land last. */
    fun refresh() {
        load?.cancel()
        _state.update { it.copy(loading = true, error = null) }
        load = viewModelScope.launch {
            try {
                val sessions = pty.ptySessions().filter { it.id.startsWith(TERMINAL_PAGE_PREFIX) }
                _state.update { it.copy(sessions = sessions, loading = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = "Couldn't load terminals: ${e.message}") }
            }
        }
    }

    fun kill(id: String) {
        viewModelScope.launch {
            try {
                pty.ptyKill(id)
                _state.update { state -> state.copy(sessions = state.sessions.filterNot { it.id == id }) }
                refresh()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(error = "Couldn't end the terminal: ${e.message}") }
            }
        }
    }
}

private const val TERMINAL_PAGE_PREFIX = "${PtyIds.TERMINAL_SURFACE}/"

/** What a session is called, in the list and on the terminal's header. */
fun sessionTitle(session: PtySession): String = when (session.kind) {
    "agent" -> "${session.harness?.name ?: "Agent"} · ${session.workspaceId ?: session.id}"
    "review" -> "Review · ${session.workspaceId ?: session.id}"
    else -> session.cwd?.trimEnd('/')?.substringAfterLast('/')?.ifEmpty { null } ?: "Home"
}

fun sessionDetail(session: PtySession): String {
    val state = when {
        session.running -> "Running"
        session.exitCode != null -> "Exited (${session.exitCode})"
        else -> "Exited"
    }
    val where = if (session.kind == "shell") session.cwd ?: "Home" else null
    val attached = if (session.attached > 0) "${session.attached} attached" else null
    return listOfNotNull(state, where, attached).joinToString(" · ")
}

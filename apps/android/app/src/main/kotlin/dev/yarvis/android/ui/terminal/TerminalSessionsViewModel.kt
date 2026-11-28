package dev.yarvis.android.ui.terminal

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.yarvis.android.api.PtyApi
import dev.yarvis.android.api.PtySession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class TerminalSessionsState(
    val sessions: List<PtySession> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
) {
    /** Agent and review sessions first, then shells, each oldest first as the server lists them. */
    val sections: List<Pair<String, List<PtySession>>>
        get() = listOf(
            "Agents" to sessions.filter { it.kind != "shell" },
            "Shells" to sessions.filter { it.kind == "shell" },
        ).filter { it.second.isNotEmpty() }
}

/** The Terminal tab's list. The screen refreshes it on resume, so nothing loads until it's shown. */
class TerminalSessionsViewModel(private val pty: PtyApi) : ViewModel() {
    private val _state = MutableStateFlow(TerminalSessionsState())
    val state: StateFlow<TerminalSessionsState> = _state.asStateFlow()

    fun refresh() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                val sessions = pty.ptySessions()
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

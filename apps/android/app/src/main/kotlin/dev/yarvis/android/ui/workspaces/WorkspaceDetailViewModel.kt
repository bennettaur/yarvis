package dev.yarvis.android.ui.workspaces

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.yarvis.android.api.AgentConfig
import dev.yarvis.android.api.ArchiveRequest
import dev.yarvis.android.api.ProvisionEvent
import dev.yarvis.android.api.PtyApi
import dev.yarvis.android.api.PtyIds
import dev.yarvis.android.api.PtySession
import dev.yarvis.android.api.ReauthCancelledException
import dev.yarvis.android.api.WorkspaceDetail
import dev.yarvis.android.api.WorkspacesApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** A terminal to open full screen: a workspace's agent or one of its shells. */
data class TerminalTarget(val sessionId: String, val title: String, val cwd: String?)

data class WorkspaceDetailState(
    val detail: WorkspaceDetail? = null,
    val loading: Boolean = true,
    val loadError: String? = null,
    /** Every PTY session on the server; the screen shows this workspace's. */
    val sessions: List<PtySession> = emptyList(),
    val agentConfig: AgentConfig = AgentConfig(),
    /** The harness the user picked for the next start, by id. */
    val pickedHarness: String? = null,
    val agentBusy: Boolean = false,
    /** The live provision log, or null when no provision is showing. */
    val provisionLog: String? = null,
    val provisioning: Boolean = false,
    /** Ignore, archive or provision in flight, so a double tap sends once. */
    val busy: Boolean = false,
    val message: String? = null,
) {
    val agentRunning: Boolean get() = detail != null && agentRunning(sessions, detail.id)
    val shells: List<PtySession> get() = detail?.let { workspaceShells(sessions, it.id) }.orEmpty()

    /** Several harnesses to pick from, and no live agent to name one. */
    val showsHarnessPicker: Boolean
        get() = detail?.status == "active" && !agentRunning && agentConfig.harnesses.size > 1

    val agentName: String get() = chosenHarness(agentConfig, pickedHarness)?.name ?: agentConfig.name
}

/**
 * One workspace: its repos and PRs, its agent and shells, and the provision and
 * archive flows. A workspace still being set up, such as one the form just
 * created, follows its provision log as soon as it opens.
 */
class WorkspaceDetailViewModel(
    private val api: WorkspacesApi,
    private val pty: PtyApi,
    private val id: String,
) : ViewModel() {
    private val _state = MutableStateFlow(WorkspaceDetailState())
    val state: StateFlow<WorkspaceDetailState> = _state.asStateFlow()

    /** A terminal the screen should open next: set by a start, cleared once opened. */
    private val _pendingOpen = MutableStateFlow<TerminalTarget?>(null)
    val pendingOpen: StateFlow<TerminalTarget?> = _pendingOpen.asStateFlow()

    private var poll: Job? = null
    private var provisionJob: Job? = null

    init {
        viewModelScope.launch {
            loadAgentConfig()
        }
        viewModelScope.launch {
            reload(background = false)
            val detail = _state.value.detail
            if (detail != null && followsProvisionOnOpen(detail)) provision()
        }
    }

    fun resume() {
        poll?.cancel()
        poll = viewModelScope.launch {
            reload(background = true)
            while (true) {
                delay(if (_state.value.detail?.isTearingDown == true) TEARDOWN_POLL_MS else POLL_MS)
                reload(background = true)
            }
        }
    }

    fun pause() {
        poll?.cancel()
        poll = null
    }

    fun refresh() {
        viewModelScope.launch { reload(background = false) }
    }

    fun dismissMessage() {
        _state.update { it.copy(message = null) }
    }

    fun opened() {
        _pendingOpen.value = null
    }

    fun pickHarness(id: String) {
        _state.update { it.copy(pickedHarness = id) }
    }

    /** Opens the live agent, or starts one first. Opening a dead agent id would spawn a plain shell there. */
    fun openOrStartAgent() {
        val current = _state.value
        val detail = current.detail ?: return
        if (current.agentBusy) return
        if (current.agentRunning) {
            _pendingOpen.value = agentTarget(detail, current)
            return
        }
        val harness = if (current.agentConfig.harnesses.size > 1) chosenHarness(current.agentConfig, current.pickedHarness)?.id else null
        _state.update { it.copy(agentBusy = true) }
        viewModelScope.launch {
            try {
                reportingFailure("Couldn't start the agent") {
                    api.startAgent(detail, harness)
                    _pendingOpen.value = agentTarget(detail, _state.value)
                    reloadSessions()
                }
            } finally {
                _state.update { it.copy(agentBusy = false) }
            }
        }
    }

    /**
     * Ends the agent session, then tells the sidecar, since killing the PTY
     * alone would let a restart resume it.
     */
    fun stopAgent() {
        if (_state.value.agentBusy) return
        _state.update { it.copy(agentBusy = true) }
        viewModelScope.launch {
            try {
                reportingFailure("Couldn't stop the agent") {
                    pty.ptyKill(PtyIds.agent(id))
                    api.stopAgent(id)
                }
                reloadSessions()
            } finally {
                _state.update { it.copy(agentBusy = false) }
            }
        }
    }

    fun shellTarget(session: PtySession): TerminalTarget? {
        val detail = _state.value.detail ?: return null
        return TerminalTarget(session.id, "${detail.name} · shell", detail.rootPath)
    }

    /** A fresh pane on the workspace's surface; attaching to it spawns the shell. */
    fun newShell(): TerminalTarget? {
        val detail = _state.value.detail ?: return null
        return TerminalTarget(PtyIds.newPane(PtyIds.workspaceSurface(id)), "${detail.name} · shell", detail.rootPath)
    }

    /** Starts provisioning, or follows the run already going. */
    fun provision() {
        if (provisionJob?.isActive == true) return
        _state.update { it.copy(provisionLog = "", provisioning = true, message = null) }
        provisionJob = viewModelScope.launch {
            var failure: String? = null
            try {
                api.provision(id).collect { event ->
                    provisionLogText(event)?.let { text -> _state.update { it.copy(provisionLog = it.provisionLog.orEmpty() + text) } }
                    if (event is ProvisionEvent.Error) failure = event.message
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = e.message ?: "The provision stream ended"
            }
            // A failed repo still ends with `done`; the detail shows its error. Only a
            // failure of the whole run keeps the log up, so its cause stays readable.
            _state.update {
                if (failure == null) {
                    it.copy(provisioning = false, provisionLog = null)
                } else {
                    it.copy(provisioning = false, message = "Provisioning failed: $failure")
                }
            }
            reload(background = true)
        }
    }

    fun closeProvisionLog() {
        if (_state.value.provisioning) return
        _state.update { it.copy(provisionLog = null) }
    }

    fun ignoreError() = runExclusive("Couldn't ignore the error") {
        api.ignoreWorkspaceError(id)
        reload(background = true)
    }

    /**
     * Starts the archive and follows it until the worktrees are gone or one
     * refuses to go. [onStarted] runs once the sidecar accepted it, so the
     * dialog can close while the teardown runs, as the web's does.
     */
    fun archive(request: ArchiveRequest, onStarted: () -> Unit) = runExclusive("Couldn't archive") {
        api.archiveWorkspace(id, request)
        onStarted()
        reload(background = true)
        while (_state.value.detail?.isTearingDown == true) {
            delay(TEARDOWN_POLL_MS)
            reload(background = true)
        }
    }

    private suspend fun loadAgentConfig() {
        try {
            val config = api.agentConfig()
            _state.update { it.copy(agentConfig = config) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The default agent still starts; the picker just isn't offered.
        }
    }

    private suspend fun reload(background: Boolean) {
        try {
            val detail = api.workspace(id, viewing = true)
            _state.update { it.copy(detail = detail, loading = false, loadError = null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update {
                it.copy(loading = false, loadError = if (background && it.detail != null) it.loadError else "Couldn't load the workspace: ${e.message}")
            }
        }
        reloadSessions()
    }

    private suspend fun reloadSessions() {
        try {
            val sessions = pty.ptySessions()
            _state.update { it.copy(sessions = sessions) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keeps the last list; a device without the terminal scope never gets one.
        }
    }

    private fun agentTarget(detail: WorkspaceDetail, state: WorkspaceDetailState) =
        TerminalTarget(PtyIds.agent(detail.id), "${detail.name} · ${state.agentName}", detail.rootPath)

    private fun runExclusive(failure: String, block: suspend () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true) }
        viewModelScope.launch {
            try {
                reportingFailure(failure, block)
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    private suspend fun reportingFailure(failure: String, block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (_: ReauthCancelledException) {
            // The user closed the code prompt; nothing was sent.
        } catch (e: Exception) {
            _state.update { it.copy(message = "$failure: ${e.message}") }
        }
    }

    private companion object {
        const val POLL_MS = 20_000L
        const val TEARDOWN_POLL_MS = 2_000L
    }
}

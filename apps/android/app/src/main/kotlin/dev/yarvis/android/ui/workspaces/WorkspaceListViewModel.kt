package dev.yarvis.android.ui.workspaces

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.yarvis.android.api.WorkspaceSummary
import dev.yarvis.android.api.WorkspacesApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class WorkspaceListState(
    val workspaces: List<WorkspaceSummary> = emptyList(),
    /** Nothing loaded yet. */
    val loading: Boolean = true,
    /** A load running behind a list already on screen. */
    val refreshing: Boolean = false,
    val error: String? = null,
    val showArchived: Boolean = false,
) {
    val groups: List<WorkspaceGroup> get() = shownGroups(workspaces, showArchived)
    val archivedCount: Int get() = workspaces.count { it.status == "archived" }
}

/** The workspace list. It polls only while the screen is resumed, as the other clients poll only while visible. */
class WorkspaceListViewModel(private val api: WorkspacesApi) : ViewModel() {
    private val _state = MutableStateFlow(WorkspaceListState())
    val state: StateFlow<WorkspaceListState> = _state.asStateFlow()

    private var poll: Job? = null

    /** Bumped per load, so an older answer that lands last is dropped. */
    private var generation = 0

    fun resume() {
        poll?.cancel()
        poll = viewModelScope.launch {
            load(background = true)
            while (true) {
                // Faster while a teardown runs, so its row settles promptly.
                delay(if (_state.value.workspaces.any { it.isTearingDown }) TEARDOWN_POLL_MS else POLL_MS)
                load(background = true)
            }
        }
    }

    fun pause() {
        poll?.cancel()
        poll = null
    }

    /** Pull to refresh: the user is waiting on it, so a failure shows. */
    fun refresh() {
        viewModelScope.launch { load(background = false) }
    }

    fun toggleArchived() {
        _state.update { it.copy(showArchived = !it.showArchived) }
    }

    /** A background poll that fails keeps the last list and says nothing, unless nothing has loaded. */
    private suspend fun load(background: Boolean) {
        val mine = ++generation
        _state.update { it.copy(refreshing = true) }
        try {
            val fresh = api.workspaces(badges = true)
            if (mine == generation) _state.update { it.copy(workspaces = fresh, loading = false, refreshing = false, error = null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (mine != generation) return
            _state.update {
                val show = !background || it.loading
                it.copy(loading = false, refreshing = false, error = if (show) "Couldn't load workspaces: ${e.message}" else it.error)
            }
        }
    }

    private companion object {
        const val POLL_MS = 20_000L
        const val TEARDOWN_POLL_MS = 2_000L
    }
}

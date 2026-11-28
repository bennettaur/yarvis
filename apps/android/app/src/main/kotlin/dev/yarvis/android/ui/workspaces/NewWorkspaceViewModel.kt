package dev.yarvis.android.ui.workspaces

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.yarvis.android.api.NewWorkspace
import dev.yarvis.android.api.Repo
import dev.yarvis.android.api.WorkspaceSummary
import dev.yarvis.android.api.WorkspaceTask
import dev.yarvis.android.api.WorkspacesApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** A ticked repo's remote branches, fetched when it is ticked. */
sealed interface Branches {
    data object Loading : Branches
    data class Loaded(val names: List<String>) : Branches
    data class Failed(val message: String) : Branches
}

data class NewWorkspaceState(
    val name: String = "",
    val repos: List<Repo> = emptyList(),
    val reposLoading: Boolean = true,
    val reposError: String? = null,
    val tasks: List<WorkspaceTask> = emptyList(),
    val ticked: Set<String> = emptySet(),
    val branches: Map<String, Branches> = emptyMap(),
    /** The existing branch picked per repo id; absent is a new branch. */
    val chosenBranch: Map<String, String> = emptyMap(),
    val taskId: String? = null,
    val busy: Boolean = false,
    val error: String? = null,
    /** Set once the workspace exists; the screen moves to its detail. */
    val created: WorkspaceSummary? = null,
)

/** The new-workspace form, with the web's and the Mac app's labels and validation. */
class NewWorkspaceViewModel(private val api: WorkspacesApi) : ViewModel() {
    private val _state = MutableStateFlow(NewWorkspaceState())
    val state: StateFlow<NewWorkspaceState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            try {
                val repos = api.repos()
                _state.update { it.copy(repos = repos, reposLoading = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(reposLoading = false, reposError = "Couldn't load repos: ${e.message}") }
            }
        }
        viewModelScope.launch {
            // Linking a task is optional, so a failure only hides the picker.
            val tasks = try {
                api.openTasks()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                emptyList()
            }
            _state.update { it.copy(tasks = tasks) }
        }
    }

    fun setName(name: String) {
        _state.update { it.copy(name = name) }
    }

    fun setTask(taskId: String?) {
        _state.update { it.copy(taskId = taskId) }
    }

    fun toggle(repoId: String) {
        val wasTicked = repoId in _state.value.ticked
        _state.update { it.copy(ticked = if (wasTicked) it.ticked - repoId else it.ticked + repoId) }
        if (!wasTicked) {
            when (_state.value.branches[repoId]) {
                null, is Branches.Failed -> loadBranches(repoId)
                Branches.Loading, is Branches.Loaded -> Unit
            }
        }
    }

    fun loadBranches(repoId: String) {
        _state.update { it.copy(branches = it.branches + (repoId to Branches.Loading)) }
        viewModelScope.launch {
            val result = try {
                Branches.Loaded(api.repoBranches(repoId))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Branches.Failed(e.message ?: "Couldn't load branches")
            }
            _state.update { it.copy(branches = it.branches + (repoId to result)) }
        }
    }

    /** A null [branch] goes back to a new branch. */
    fun chooseBranch(repoId: String, branch: String?) {
        _state.update { it.copy(chosenBranch = if (branch == null) it.chosenBranch - repoId else it.chosenBranch + (repoId to branch)) }
    }

    fun create() {
        val current = _state.value
        if (current.busy || current.created != null) return
        val name = current.name.trim()
        if (name.isEmpty()) {
            _state.update { it.copy(error = "Pick a name.") }
            return
        }
        // In the list's order, so the workspace's repos read as the form did.
        val repoIds = current.repos.map { it.id }.filter { it in current.ticked }
        val branches = current.chosenBranch.filterKeys { it in current.ticked }
        val request = NewWorkspace(
            name = name,
            repoIds = repoIds,
            existingBranches = branches.ifEmpty { null },
            taskId = current.taskId,
        )
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val created = api.createWorkspace(request)
                _state.update { it.copy(busy = false, created = created) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, error = e.message ?: "Couldn't create the workspace") }
            }
        }
    }
}

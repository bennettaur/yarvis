package dev.yarvis.android.ui.workspaces

import dev.yarvis.android.api.AgentConfig
import dev.yarvis.android.api.ArchiveRequest
import dev.yarvis.android.api.NewWorkspace
import dev.yarvis.android.api.ProvisionEvent
import dev.yarvis.android.api.PtyApi
import dev.yarvis.android.api.PtyConnection
import dev.yarvis.android.api.PtySession
import dev.yarvis.android.api.Repo
import dev.yarvis.android.api.WorkspaceDetail
import dev.yarvis.android.api.WorkspaceRepoDetail
import dev.yarvis.android.api.WorkspaceSummary
import dev.yarvis.android.api.WorkspaceSummaryPr
import dev.yarvis.android.api.WorkspaceTask
import dev.yarvis.android.api.WorkspacesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.transformWhile

/** Records every call in [calls], in order, as `name:args`. */
class FakeWorkspacesApi : WorkspacesApi, PtyApi {
    val calls = mutableListOf<String>()

    var list = listOf<WorkspaceSummary>()
    var listFailure: Exception? = null

    /** Answers to [workspace], in order; the last one repeats. */
    var details = mutableListOf<WorkspaceDetail>()
    var repos = listOf<Repo>()
    var branches = mapOf<String, List<String>>()
    var tasks = listOf<WorkspaceTask>()
    var config = AgentConfig()
    var sessions = mutableListOf<PtySession>()
    var createFailure: Exception? = null
    var startFailure: Exception? = null

    var archiveFailure: Exception? = null

    /** What a provision stream does next: deliver an event, throw, or end without `done`. */
    private sealed interface ProvisionStep {
        data class Event(val event: ProvisionEvent) : ProvisionStep
        data class Fail(val error: Exception) : ProvisionStep
        data object End : ProvisionStep
    }

    private val provisionSteps = MutableSharedFlow<ProvisionStep>(replay = 64)

    /** Drives the provision stream; it ends after a [ProvisionEvent.Done] or [ProvisionEvent.Error]. */
    suspend fun emitProvision(event: ProvisionEvent) = provisionSteps.emit(ProvisionStep.Event(event))

    /** The stream throws, as a dropped connection does. */
    suspend fun provisionFailure(error: Exception) = provisionSteps.emit(ProvisionStep.Fail(error))

    /** The stream ends with neither `done` nor `error`. */
    suspend fun endProvision() = provisionSteps.emit(ProvisionStep.End)

    /** Set by [startAgent], so a test can see the session appear. */
    var onStartAgent: (WorkspaceDetail) -> Unit = { ws -> sessions += session("ws-claude:${ws.id}", kind = "agent") }

    override suspend fun workspaces(badges: Boolean): List<WorkspaceSummary> {
        calls += "workspaces:$badges"
        listFailure?.let { throw it }
        return list
    }

    override suspend fun workspace(id: String, viewing: Boolean): WorkspaceDetail {
        calls += "workspace:$id"
        return if (details.size > 1) details.removeAt(0) else details.single()
    }

    override suspend fun createWorkspace(new: NewWorkspace): WorkspaceSummary {
        calls += "create:$new"
        createFailure?.let { throw it }
        return summary("new-1", new.name, status = "creating")
    }

    override fun provision(id: String): Flow<ProvisionEvent> {
        calls += "provision:$id"
        return provisionSteps.transformWhile { step ->
            when (step) {
                is ProvisionStep.Event -> {
                    emit(step.event)
                    step.event !is ProvisionEvent.Done && step.event !is ProvisionEvent.Error
                }
                is ProvisionStep.Fail -> throw step.error
                ProvisionStep.End -> false
            }
        }
    }

    override suspend fun ignoreWorkspaceError(id: String) {
        calls += "ignore:$id"
    }

    override suspend fun archiveWorkspace(id: String, request: ArchiveRequest) {
        calls += "archive:$id:$request"
        archiveFailure?.let { throw it }
    }

    override suspend fun repos(): List<Repo> = repos

    override suspend fun repoBranches(repoId: String): List<String> {
        calls += "branches:$repoId"
        return branches[repoId] ?: throw IllegalStateException("no remote")
    }

    override suspend fun openTasks(): List<WorkspaceTask> = tasks

    override suspend fun agentConfig(): AgentConfig = config

    override suspend fun startAgent(workspace: WorkspaceDetail, harness: String?) {
        calls += "startAgent:${workspace.id}:$harness"
        startFailure?.let { throw it }
        onStartAgent(workspace)
    }

    override suspend fun stopAgent(workspaceId: String) {
        calls += "stopAgent:$workspaceId"
    }

    override suspend fun ptySessions(): List<PtySession> = sessions.toList()

    override suspend fun ptyKill(id: String) {
        calls += "kill:$id"
        sessions.removeAll { it.id == id }
    }

    override suspend fun ptyExists(id: String): Boolean = sessions.any { it.id == id && it.running }

    override fun attachPty(
        sessionId: String,
        cols: Int,
        rows: Int,
        cwd: String?,
        offset: Long?,
        mayReconnect: (suspend () -> Boolean)?,
    ): PtyConnection = throw UnsupportedOperationException("the workspace screens never attach")
}

fun summary(
    id: String,
    name: String = id,
    status: String = "active",
    repoNames: List<String> = emptyList(),
    prs: List<WorkspaceSummaryPr> = emptyList(),
    error: String? = null,
) = WorkspaceSummary(id = id, name = name, status = status, rootPath = "/ws/$id", repoNames = repoNames, prs = prs, error = error)

fun repo(id: String, name: String = id) = Repo(id = id, name = name, owner = "acme", repo = name)

fun detail(
    id: String = "w1",
    status: String = "active",
    repos: List<WorkspaceRepoDetail> = emptyList(),
    error: String? = null,
) = WorkspaceDetail(id = id, name = "Workspace $id", status = status, rootPath = "/ws/$id", repos = repos, error = error)

fun workspaceRepo(id: String, status: String = "ready", error: String? = null, name: String = id) = WorkspaceRepoDetail(
    id = id,
    workspaceId = "w1",
    repoId = "r-$id",
    status = status,
    branch = "yarvis/$id",
    worktreePath = "/ws/w1/$id",
    error = error,
    repo = repo("r-$id", name),
)

fun session(id: String, kind: String = "shell", running: Boolean = true) = PtySession(id = id, kind = kind, running = running)

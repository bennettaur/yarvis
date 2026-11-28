package dev.yarvis.android.api

import kotlinx.coroutines.flow.Flow

/** The sidecar's workspace routes behind `/api/sidecar`, and the core commands that start an agent. */
interface WorkspacesApi {
    /** `badges` tells the sidecar the user is looking, so it polls PR badges sooner. */
    suspend fun workspaces(badges: Boolean): List<WorkspaceSummary>

    /** `viewing` keeps the workspace's PRs fresh on the sidecar. */
    suspend fun workspace(id: String, viewing: Boolean): WorkspaceDetail
    suspend fun createWorkspace(new: NewWorkspace): WorkspaceSummary

    /** Starts provisioning, or follows the run already going. Ending the collector doesn't stop the run. */
    fun provision(id: String): Flow<ProvisionEvent>

    /** Marks a failed workspace usable as it is. 409 while a provision still runs. */
    suspend fun ignoreWorkspaceError(id: String)

    /** Starts the archive in the background (202); poll [workspace] to follow it. */
    suspend fun archiveWorkspace(id: String, request: ArchiveRequest)
    suspend fun repos(): List<Repo>

    /** A repo's remote branches, for picking one to work on. */
    suspend fun repoBranches(repoId: String): List<String>
    suspend fun openTasks(): List<WorkspaceTask>
    suspend fun agentConfig(): AgentConfig

    /** Starts `ws-claude:<id>` in the workspace's root. A null [harness] uses the default. */
    suspend fun startAgent(workspace: WorkspaceDetail, harness: String?)

    /** Tells the sidecar the user ended the agent, so a restart doesn't resume it. */
    suspend fun stopAgent(workspaceId: String)
}

/** The server's PTY routes. All need the `terminal` scope. */
interface PtyApi {
    /** Every session on the server, oldest first. */
    suspend fun ptySessions(): List<PtySession>

    /** Ends the session; fine when there is none. */
    suspend fun ptyKill(id: String)

    /** True while a shell runs there, without spawning one. */
    suspend fun ptyExists(id: String): Boolean

    /**
     * A connection to `/api/pty/{sessionId}`, not yet started. [cwd] is where a
     * shell spawned by this attach opens. [offset] is an earlier connection's
     * [PtyConnection.offset], so a reattach after a close only catches up
     * on what the screen missed. [mayReconnect] runs before each
     * reconnect; false ends the connection with [PtyUpdate.Refused] (code 1000).
     * Agent and review ids must pass one that checks [ptyExists], since
     * attaching to a dead id spawns a plain shell there.
     */
    fun attachPty(
        sessionId: String,
        cols: Int,
        rows: Int,
        cwd: String? = null,
        offset: Long? = null,
        mayReconnect: (suspend () -> Boolean)? = null,
    ): PtyConnection
}

/** What a [PtyConnection] reports to the terminal that shows it. */
sealed interface PtyUpdate {
    /** Clear the screen before the next output (a snapshot catch-up). */
    data object Reset : PtyUpdate

    /** Bytes to feed the terminal, with any overlap already trimmed. */
    class Output(val bytes: ByteArray) : PtyUpdate

    /** The PTY's size or its owner changed. [owner] is a client id, or null. */
    data class Size(val cols: Int, val rows: Int, val owner: Long?) : PtyUpdate

    /** The shell exited. The connection ends. */
    data class Exit(val code: Int?) : PtyUpdate

    /** The server refused the attach; [Refused] with 4400 follows. */
    data class Error(val message: String) : PtyUpdate

    /** 4401. Sign in again. The connection ends. */
    data object SignedOut : PtyUpdate

    /** 4400, 4403, or [PtyApi.attachPty]'s `mayReconnect` said no (1000). The connection ends. */
    data class Refused(val code: Int) : PtyUpdate

    /** The socket dropped and a reconnect is coming. */
    data object Reconnecting : PtyUpdate
}

/**
 * One terminal attached to one PTY session. Reconnects after a drop and
 * resumes from the last byte it delivered.
 */
interface PtyConnection {
    /** Hot; collect it before [start] so the first catch-up isn't missed. Completes when the connection ends. */
    val updates: Flow<PtyUpdate>

    /** One past the last byte delivered, or null before any: where a later attach resumes. */
    val offset: Long?
    fun start()

    /** Closes the socket for good. The session keeps running on the server. */
    fun close()

    /** Keystrokes, split so no message passes the server's 64 KiB limit. */
    fun send(input: ByteArray)

    /** The viewport in cells. Ignored when either is 0. */
    fun resize(cols: Int, rows: Int)

    /** Takes over the PTY size, as typing does. */
    fun focus()
}

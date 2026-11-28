package dev.yarvis.android.api

import kotlinx.serialization.Serializable

// The Workspaces page's JSON, from the sidecar's `workspaces/routes.ts` and the
// web's `src/lib/workspaces.ts`, and the server's PTY list. Provider-reported
// values (PR state, mergeable, check rollups) stay free-form strings, since a
// provider can report a value this build has never seen.

/** A registered repository (`GET /api/repos`). */
@Serializable
data class Repo(
    val id: String,
    val name: String,
    val owner: String,
    val repo: String,
    val cloneUrl: String = "",
    val defaultBranch: String? = null,
) {
    /** `owner/repo`, as the repo checklist shows it. */
    val fullName: String get() = "$owner/$repo"
}

/** A PR as the workspace list shows it: enough for one status line. */
@Serializable
data class WorkspaceSummaryPr(
    val repoName: String,
    val prNumber: Int,
    /** `open`, `closed`, `merged`, or null. */
    val prState: String? = null,
    val isDraft: Boolean? = null,
    val mergeable: String? = null,
    /** `success`, `failure`, `pending` or `none`. */
    val checkRollup: String? = null,
    /** `approved`, `changes_requested`, `review_required` or null. */
    val reviewDecision: String? = null,
)

/** One row of `GET /api/workspaces`, and the answer to a create. */
@Serializable
data class WorkspaceSummary(
    val id: String,
    val name: String,
    /** `creating`, `active`, `archiving`, `archived` or `error`. */
    val status: String,
    val rootPath: String,
    val repoNames: List<String> = emptyList(),
    val slug: String? = null,
    val summary: String? = null,
    val mergedPrUrl: String? = null,
    val error: String? = null,
    val archivedAt: String? = null,
    /** One per linked PR, the main one first. Absent on a create's answer. */
    val prs: List<WorkspaceSummaryPr> = emptyList(),
    /** When the workspace was last opened or its agent last did something; null once archived. */
    val lastActiveAt: String? = null,
)

@Serializable
data class PrCheckCounts(val total: Int = 0, val success: Int = 0, val failure: Int = 0, val pending: Int = 0)

/** A PR linked to one of a workspace's repos, as the sidecar's poller last saw it. */
@Serializable
data class WorkspaceRepoPr(
    val prNumber: Int? = null,
    val prUrl: String? = null,
    val prState: String? = null,
    /** Set when the PR is on another branch than the workspace's, such as a stack layer. */
    val headBranch: String? = null,
    val isDraft: Boolean? = null,
    val mergeable: String? = null,
    val checkRollup: String? = null,
    val checks: PrCheckCounts? = null,
    val reviewDecision: String? = null,
    val lastError: String? = null,
)

/** One repo of a workspace: its worktree, branch and PRs. */
@Serializable
data class WorkspaceRepoDetail(
    val id: String,
    val workspaceId: String,
    val repoId: String,
    /** `pending`, `provisioning`, `ready`, `removed` or `error`. */
    val status: String,
    val branch: String,
    val baseBranch: String? = null,
    val worktreePath: String,
    val setupLog: String? = null,
    val setupExitCode: Int? = null,
    val error: String? = null,
    val repo: Repo,
    val prs: List<WorkspaceRepoPr> = emptyList(),
    /** Null until the sidecar's poller has looked at this repo's PRs once. */
    val prsPolledAt: String? = null,
    val prsPollError: String? = null,
)

/** One of the user's tasks (`/api/tasks`). */
@Serializable
data class WorkspaceTask(
    val id: String,
    val title: String,
    /** `open` or `done`. */
    val status: String = "open",
)

/** A tracker issue linked to a workspace. */
@Serializable
data class IssueLink(
    val id: String,
    /** `github`, `jira` or `azure`. */
    val provider: String,
    val sourceKey: String = "",
    val externalId: String,
    val title: String? = null,
    val url: String? = null,
    /** `todo`, `in_progress` or `done`. */
    val localStatus: String? = null,
)

/** `GET /api/workspaces/{id}`. The lists default to empty so a sidecar that leaves one out still loads. */
@Serializable
data class WorkspaceDetail(
    val id: String,
    val name: String,
    val slug: String? = null,
    /** `creating`, `active`, `archiving`, `archived` or `error`. */
    val status: String,
    val rootPath: String,
    val summary: String? = null,
    val mergedPrUrl: String? = null,
    val error: String? = null,
    val archivedAt: String? = null,
    val repos: List<WorkspaceRepoDetail> = emptyList(),
    val tasks: List<WorkspaceTask> = emptyList(),
    val issues: List<IssueLink> = emptyList(),
)

/** What the new-workspace form sends (`POST /api/workspaces`). */
@Serializable
data class NewWorkspace(
    val name: String,
    val repoIds: List<String>,
    /** An existing remote branch per repo id; a repo left out gets a new branch. */
    val existingBranches: Map<String, String>? = null,
    val taskId: String? = null,
    val startWork: Boolean? = null,
)

/** What the archive dialog sends (`POST /api/workspaces/{id}/archive`). */
@Serializable
data class ArchiveRequest(
    val summary: String? = null,
    val mergedPrUrl: String? = null,
    /** Archive even with uncommitted or unpushed work. */
    val force: Boolean = false,
    val closeIssueIds: List<String> = emptyList(),
)

/** One message on the provision stream (`POST /api/workspaces/{id}/provision`, SSE). */
sealed interface ProvisionEvent {
    data class RepoStart(val workspaceRepoId: String, val repo: String) : ProvisionEvent
    data class Log(val workspaceRepoId: String, val text: String) : ProvisionEvent
    data class RepoDone(val workspaceRepoId: String, val status: String) : ProvisionEvent
    data class RepoError(val workspaceRepoId: String, val message: String) : ProvisionEvent

    /** Ends the run. */
    data class Done(val status: String) : ProvisionEvent

    /** Ends the run with a failure of the whole provision. */
    data class Error(val message: String) : ProvisionEvent
}

/** An agent program the user configured (`get_agent_config`). */
@Serializable
data class AgentHarness(val id: String, val name: String, val kind: String? = null)

@Serializable
data class AgentConfig(
    val name: String = "Claude",
    val harnesses: List<AgentHarness> = emptyList(),
    val defaultHarness: String? = null,
)

/** One row of `GET /api/pty`. */
@Serializable
data class PtySession(
    val id: String,
    /** `agent` (a workspace's `ws-claude:`), `review` (`review-claude:`) or `shell`. */
    val kind: String,
    val workspaceId: String? = null,
    val cwd: String? = null,
    val harness: AgentHarness? = null,
    /** Unix milliseconds. */
    val startedAt: Long = 0,
    val running: Boolean,
    val exitCode: Int? = null,
    /** Clients attached right now. */
    val attached: Int = 0,
)

/**
 * PTY session ids, in the web's shapes (`src/components/shell/terminalTabs/sessionIds.ts`).
 * Attention items and the other clients name sessions by these, so they must not change.
 */
object PtyIds {
    const val AGENT_PREFIX = "ws-claude:"
    const val REVIEW_PREFIX = "review-claude:"

    /** The Terminal page's surface. Its panes are `tab:terminal/<tab>/<pane>`. */
    const val TERMINAL_SURFACE = "tab:terminal"

    fun agent(workspaceId: String) = "$AGENT_PREFIX$workspaceId"

    /** A workspace's terminal surface. Its panes are `ws:<id>/<tab>/<pane>`. */
    fun workspaceSurface(workspaceId: String) = "ws:$workspaceId"

    /** A pane's id: `<surface>/<tabId>/<paneId>`. */
    fun pane(surface: String, tabId: String, paneId: String) = "$surface/$tabId/$paneId"

    /** True for ids only the server or sidecar may start; attaching to a dead one must not spawn a shell. */
    fun isAgentOrReview(id: String) = id.startsWith(AGENT_PREFIX) || id.startsWith(REVIEW_PREFIX)

    /** The surface, tab and pane of a pane id, or null for any other id, such as `ws-claude:…`. */
    fun parsePane(id: String): Triple<String, String, String>? {
        val parts = id.split('/')
        if (parts.size != 3 || parts.any { it.isEmpty() }) return null
        return Triple(parts[0], parts[1], parts[2])
    }

    /**
     * A fresh pane id on [surface], in its own tab. Uids are the web's: `t` or `p`,
     * the time in base 36, then a counter in base 36, so two minted in one millisecond differ.
     */
    fun newPane(surface: String, now: Long = System.currentTimeMillis()): String =
        pane(surface, uid("t", now), uid("p", now))

    private val counter = java.util.concurrent.atomic.AtomicLong()

    private fun uid(kind: String, now: Long) = kind + now.toString(36) + counter.getAndIncrement().toString(36)
}

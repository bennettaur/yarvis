package dev.yarvis.android.ui.workspaces

import dev.yarvis.android.api.AgentConfig
import dev.yarvis.android.api.AgentHarness
import dev.yarvis.android.api.IssueLink
import dev.yarvis.android.api.ProvisionEvent
import dev.yarvis.android.api.PtyIds
import dev.yarvis.android.api.PtySession
import dev.yarvis.android.api.WorkspaceDetail
import dev.yarvis.android.api.WorkspaceRepoDetail
import dev.yarvis.android.api.WorkspaceRepoPr
import dev.yarvis.android.api.WorkspaceSummary
import dev.yarvis.android.api.WorkspaceSummaryPr

// The Workspaces page's rules, as the web (`WorkspacesPanel.tsx`, `prGlance.ts`,
// `components/workspaces/`) and the Mac app (`WorkspaceLogic.swift`) have them,
// since all three show the same workspaces and a user moves between them.

data class WorkspaceGroup(val label: String, val workspaces: List<WorkspaceSummary>)

/**
 * Groups the list by repo: one group per repo for single-repo workspaces
 * ("Scratch" for none), then one per set of repos. Each set is sorted by label;
 * inside a group the server's order stands.
 */
fun groupWorkspaces(list: List<WorkspaceSummary>): List<WorkspaceGroup> {
    val single = LinkedHashMap<String, MutableList<WorkspaceSummary>>()
    val multi = LinkedHashMap<String, MutableList<WorkspaceSummary>>()
    for (ws in list) {
        if (ws.repoNames.size <= 1) {
            single.getOrPut(ws.repoNames.firstOrNull() ?: "Scratch") { mutableListOf() } += ws
        } else {
            // Code point order, so two names a collation ties still make one group.
            multi.getOrPut(ws.repoNames.sorted().joinToString(" + ")) { mutableListOf() } += ws
        }
    }
    fun sorted(groups: Map<String, List<WorkspaceSummary>>) =
        groups.map { WorkspaceGroup(it.key, it.value) }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })
    return sorted(single) + sorted(multi)
}

/** Archived workspaces are hidden until the user asks for them. */
fun shownGroups(list: List<WorkspaceSummary>, showArchived: Boolean): List<WorkspaceGroup> =
    groupWorkspaces(if (showArchived) list else list.filterNot { it.status == "archived" })

/** An archive still removing worktrees, with nothing stopping it yet. */
val WorkspaceSummary.isTearingDown: Boolean get() = status == "archiving" && error == null
val WorkspaceDetail.isTearingDown: Boolean get() = status == "archiving" && error == null

fun workspaceStatusHelp(status: String): String = when (status) {
    "creating" -> "Setting up the workspace's worktrees."
    "active" -> "Set up and ready to work in."
    "archiving" -> "Removing the workspace's worktrees; any that could not be removed show an error."
    "archived" -> "Archived; its worktrees have been removed."
    "error" -> "Something went wrong setting up or archiving the workspace; see its repos for details."
    else -> status
}

/** A PR's state at a glance, most pressing first. */
enum class PrGlance(val icon: String, val label: String) {
    Merged("◆", "merged"),
    Closed("⊘", "closed"),
    Draft("◌", "draft"),
    Conflicts("⚠", "merge conflicts"),
    ChecksFailing("✗", "checks failing"),
    ChangesRequested("✎", "changes requested"),
    ChecksRunning("●", "checks running"),
    ReadyToMerge("★", "ready to merge"),
    Approved("✓", "approved"),
    Open("◇", "open — awaiting review"),
}

/** GitHub says `dirty`; the shared enum the poller stores says `conflicting`. */
fun hasConflicts(mergeable: String?): Boolean = mergeable?.lowercase().let { it == "dirty" || it == "conflicting" }

fun prGlance(pr: WorkspaceSummaryPr): PrGlance =
    prGlance(pr.prState, pr.isDraft, pr.mergeable, pr.checkRollup, pr.reviewDecision)

fun prGlance(pr: WorkspaceRepoPr): PrGlance =
    prGlance(pr.prState, pr.isDraft, pr.mergeable, pr.checkRollup, pr.reviewDecision)

private fun prGlance(prState: String?, isDraft: Boolean?, mergeable: String?, checkRollup: String?, reviewDecision: String?): PrGlance {
    // A listed PR has a number, so an unset state means open.
    when ((prState ?: "open").lowercase()) {
        "merged" -> return PrGlance.Merged
        "closed" -> return PrGlance.Closed
    }
    return when {
        isDraft == true -> PrGlance.Draft
        hasConflicts(mergeable) -> PrGlance.Conflicts
        checkRollup == "failure" -> PrGlance.ChecksFailing
        reviewDecision == "changes_requested" -> PrGlance.ChangesRequested
        checkRollup == "pending" -> PrGlance.ChecksRunning
        // Only `clean` means nothing holds the merge back; anything else stays at the weaker verdict.
        reviewDecision == "approved" -> if (mergeable?.lowercase() == "clean") PrGlance.ReadyToMerge else PrGlance.Approved
        else -> PrGlance.Open
    }
}

/** Read aloud for a list row's badge, such as `api #12 checks failing`. */
fun prGlanceDescription(pr: WorkspaceSummaryPr): String = "${pr.repoName} #${pr.prNumber} ${prGlance(pr).label}"

fun checksLabel(rollup: String?): String = when (rollup) {
    "success" -> "✓ checks passing"
    "failure" -> "✗ checks failing"
    "pending" -> "● checks running"
    else -> "no checks"
}

/** The check counts beside the rollup, such as `3/4 passed, 1 failed`; null when there are none. */
fun checkCountsLabel(pr: WorkspaceRepoPr): String? {
    val checks = pr.checks ?: return null
    if (checks.total == 0) return null
    val parts = mutableListOf("${checks.success}/${checks.total} passed")
    if (checks.failure > 0) parts += "${checks.failure} failed"
    if (checks.pending > 0) parts += "${checks.pending} running"
    return parts.joinToString(", ")
}

/** What a repo with no PRs says: whether the poller has looked yet. */
fun noPrLabel(repo: WorkspaceRepoDetail): String = if (repo.prsPolledAt != null) "No PR yet" else "PR not polled yet"

fun reviewDecisionLabel(decision: String?): String? = when (decision) {
    "approved" -> "approved"
    "changes_requested" -> "changes requested"
    "review_required" -> "review required"
    else -> null
}

data class ProvisionActions(val show: Boolean, val label: String, val showIgnore: Boolean)

/**
 * The actions over a workspace that isn't ready: retry after a failure, or set
 * it up the first time. An archive's own failures are the archive's to retry,
 * so a workspace in the archive flow offers neither.
 */
fun provisionActions(detail: WorkspaceDetail): ProvisionActions {
    val inArchiveFlow = detail.status == "archiving" || detail.status == "archived"
    val failed = !inArchiveFlow && (detail.status == "error" || detail.repos.any { it.status == "error" })
    val label = when {
        failed -> "Retry provisioning"
        detail.repos.isEmpty() -> "Create folder"
        else -> "Provision worktrees"
    }
    return ProvisionActions(
        show = !inArchiveFlow && (failed || detail.status != "active"),
        label = label,
        showIgnore = detail.status == "error",
    )
}

/** A workspace opened while it is still being set up follows that run's log. */
fun followsProvisionOnOpen(detail: WorkspaceDetail): Boolean =
    detail.status == "creating" || detail.repos.any { it.status == "provisioning" }

/** What a provision event adds to the log, or null when it adds nothing. */
fun provisionLogText(event: ProvisionEvent): String? = when (event) {
    is ProvisionEvent.Log -> event.text
    is ProvisionEvent.RepoStart -> "\n=== ${event.repo} ===\n"
    is ProvisionEvent.RepoError -> "\n[error] ${event.message}\n"
    is ProvisionEvent.RepoDone, is ProvisionEvent.Done, is ProvisionEvent.Error -> null
}

/** The harness a start uses: the user's pick if it still exists, else the default. */
fun chosenHarness(config: AgentConfig, picked: String?): AgentHarness? =
    config.harnesses.firstOrNull { it.id == picked }
        ?: config.harnesses.firstOrNull { it.id == config.defaultHarness }
        ?: config.harnesses.firstOrNull()

/** The workspace's own shells: the panes of its `ws:<id>` surface, oldest first as the server lists them. */
fun workspaceShells(sessions: List<PtySession>, workspaceId: String): List<PtySession> {
    val prefix = PtyIds.workspaceSurface(workspaceId) + "/"
    return sessions.filter { it.id.startsWith(prefix) }
}

/** True while the workspace's agent session runs on the server. */
fun agentRunning(sessions: List<PtySession>, workspaceId: String): Boolean =
    sessions.any { it.id == PtyIds.agent(workspaceId) && it.running }

fun archiveButtonLabel(detail: WorkspaceDetail): String = when {
    detail.status != "archiving" -> "Archive"
    detail.error == null -> "Archiving…"
    else -> "Retry archive"
}

/** The PR URL the archive dialog starts with: the one recorded, a merged PR's, or an open one's. */
fun archivePrefillPrUrl(detail: WorkspaceDetail): String {
    detail.mergedPrUrl?.takeIf { it.isNotEmpty() }?.let { return it }
    val prs = detail.repos.flatMap { it.prs }
    prs.firstOrNull { it.prState?.lowercase() == "merged" && it.prUrl != null }?.prUrl?.let { return it }
    return prs.firstOrNull { it.prUrl != null && it.prState?.lowercase() != "closed" }?.prUrl ?: ""
}

/**
 * Why an archive is stuck: the repos whose worktree couldn't be removed, which
 * is uncommitted or unpushed work. Null while nothing blocks it. When it isn't
 * null, the dialog offers Force remove.
 */
fun archiveBlockedText(detail: WorkspaceDetail): String? {
    if (detail.status != "archiving" || detail.error == null) return null
    val repos = detail.repos.filter { it.status == "error" }
        .map { "${it.repo.name}: ${it.error ?: "worktree could not be removed"}" }
    return if (repos.isEmpty()) detail.error else repos.joinToString("; ")
}

/** An issue's label as its tracker shows it: `owner/repo#12`, `PROJ-45`, `#678`. */
fun issueLinkLabel(issue: IssueLink): String = when (issue.provider) {
    "github" -> "${issue.sourceKey}#${issue.externalId}"
    "azure" -> "#${issue.externalId}"
    else -> issue.externalId
}

/** The linked issues the archive dialog offers to close: those not already done here. */
fun unfinishedIssues(detail: WorkspaceDetail): List<IssueLink> = detail.issues.filter { it.localStatus != "done" }

/** The archive dialog's first sentence, naming the linked tasks it will mark done. */
fun archiveDescription(detail: WorkspaceDetail): String {
    val openTasks = detail.tasks.count { it.status != "done" }
    val tasks = if (openTasks > 0) " and marks $openTasks linked task${if (openTasks == 1) "" else "s"} done" else ""
    return "Removes the workspace folder and its worktrees from disk$tasks. " +
        "Runs in the background — you can keep working while it finishes."
}

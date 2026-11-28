package dev.yarvis.android.ui.workspaces

import dev.yarvis.android.api.AgentConfig
import dev.yarvis.android.api.AgentHarness
import dev.yarvis.android.api.IssueLink
import dev.yarvis.android.api.ProvisionEvent
import dev.yarvis.android.api.PtyIds
import dev.yarvis.android.api.WorkspaceRepoPr
import dev.yarvis.android.api.WorkspaceSummaryPr
import dev.yarvis.android.api.WorkspaceTask
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceRulesTest {
    @Test
    fun `groups single-repo workspaces by repo, then repo sets, each by label`() {
        val groups = groupWorkspaces(
            listOf(
                summary("a", repoNames = listOf("web")),
                summary("b", repoNames = listOf("llm", "api")),
                summary("c"),
                summary("d", repoNames = listOf("api")),
                summary("e", repoNames = listOf("api", "llm")),
                summary("f", repoNames = listOf("web")),
            ),
        )

        assertEquals(listOf("api", "Scratch", "web", "api + llm"), groups.map { it.label })
        assertEquals(listOf("a", "f"), groups[2].workspaces.map { it.id })
        assertEquals(listOf("b", "e"), groups[3].workspaces.map { it.id })
    }

    @Test
    fun `archived workspaces show only when asked for`() {
        val list = listOf(summary("a"), summary("b", status = "archived"))

        assertEquals(listOf("a"), shownGroups(list, showArchived = false).flatMap { g -> g.workspaces.map { it.id } })
        assertEquals(listOf("a", "b"), shownGroups(list, showArchived = true).flatMap { g -> g.workspaces.map { it.id } })
    }

    private fun pr(
        state: String? = "open",
        draft: Boolean? = null,
        mergeable: String? = null,
        rollup: String? = null,
        review: String? = null,
    ) = WorkspaceSummaryPr("api", 12, state, draft, mergeable, rollup, review)

    @Test
    fun `the PR glance puts the most pressing state first`() {
        assertEquals(PrGlance.Merged, prGlance(pr(state = "MERGED", rollup = "failure")))
        assertEquals(PrGlance.Closed, prGlance(pr(state = "closed")))
        assertEquals(PrGlance.Draft, prGlance(pr(draft = true, rollup = "failure")))
        assertEquals(PrGlance.Conflicts, prGlance(pr(mergeable = "dirty", rollup = "failure")))
        assertEquals(PrGlance.Conflicts, prGlance(pr(mergeable = "CONFLICTING")))
        assertEquals(PrGlance.ChecksFailing, prGlance(pr(rollup = "failure", review = "changes_requested")))
        assertEquals(PrGlance.ChangesRequested, prGlance(pr(rollup = "pending", review = "changes_requested")))
        assertEquals(PrGlance.ChecksRunning, prGlance(pr(rollup = "pending", review = "approved")))
        assertEquals(PrGlance.ReadyToMerge, prGlance(pr(review = "approved", mergeable = "clean")))
        assertEquals(PrGlance.Approved, prGlance(pr(review = "approved", mergeable = "unknown")))
        assertEquals(PrGlance.Open, prGlance(pr(state = null)))
        assertEquals("api #12 checks failing", prGlanceDescription(pr(rollup = "failure")))
    }

    @Test
    fun `check counts read as passed, failed and running`() {
        val checks = dev.yarvis.android.api.PrCheckCounts(total = 4, success = 2, failure = 1, pending = 1)

        assertEquals("2/4 passed, 1 failed, 1 running", checkCountsLabel(WorkspaceRepoPr(prNumber = 1, checks = checks)))
        assertNull(checkCountsLabel(WorkspaceRepoPr(prNumber = 1)))
        assertEquals("✗ checks failing", checksLabel("failure"))
        assertEquals("no checks", checksLabel(null))
    }

    @Test
    fun `provision actions offer a retry and the ignore after a failure`() {
        val failed = provisionActions(detail(status = "error", repos = listOf(workspaceRepo("api", status = "error"))))
        assertEquals(ProvisionActions(show = true, label = "Retry provisioning", showIgnore = true), failed)

        val ignored = provisionActions(detail(status = "active", repos = listOf(workspaceRepo("api", status = "error"))))
        assertEquals(ProvisionActions(show = true, label = "Retry provisioning", showIgnore = false), ignored)

        assertEquals("Provision worktrees", provisionActions(detail(status = "creating", repos = listOf(workspaceRepo("api", "pending")))).label)
        assertEquals("Create folder", provisionActions(detail(status = "creating")).label)
        assertFalse(provisionActions(detail(status = "active", repos = listOf(workspaceRepo("api")))).show)
    }

    @Test
    fun `an archive's own failures offer no provisioning`() {
        val stuck = detail(status = "archiving", repos = listOf(workspaceRepo("api", status = "error")), error = "dirty")

        assertFalse(provisionActions(stuck).show)
        assertFalse(provisionActions(stuck).showIgnore)
    }

    @Test
    fun `a workspace still being set up follows its provision on open`() {
        assertTrue(followsProvisionOnOpen(detail(status = "creating")))
        assertTrue(followsProvisionOnOpen(detail(status = "error", repos = listOf(workspaceRepo("api", status = "provisioning")))))
        assertFalse(followsProvisionOnOpen(detail(status = "error", repos = listOf(workspaceRepo("api", status = "error")))))
    }

    @Test
    fun `provision events add repo headers, logs and repo errors`() {
        assertEquals("\n=== api ===\n", provisionLogText(ProvisionEvent.RepoStart("wr1", "api")))
        assertEquals("npm i\n", provisionLogText(ProvisionEvent.Log("wr1", "npm i\n")))
        assertEquals("\n[error] boom\n", provisionLogText(ProvisionEvent.RepoError("wr1", "boom")))
        assertNull(provisionLogText(ProvisionEvent.Done("active")))
    }

    @Test
    fun `the harness is the user's pick while it exists, else the default`() {
        val config = AgentConfig(harnesses = listOf(AgentHarness("a", "Claude"), AgentHarness("b", "Pi")), defaultHarness = "b")

        assertEquals("a", chosenHarness(config, picked = "a")?.id)
        assertEquals("b", chosenHarness(config, picked = "gone")?.id)
        assertEquals("a", chosenHarness(config.copy(defaultHarness = null), picked = null)?.id)
        assertNull(chosenHarness(AgentConfig(), picked = null))
    }

    @Test
    fun `a workspace's shells are its own surface's panes only`() {
        val sessions = listOf(
            session(PtyIds.pane("ws:w1", "t1", "p1")),
            session(PtyIds.agent("w1"), kind = "agent"),
            session(PtyIds.pane("ws:w10", "t1", "p1")),
            session(PtyIds.pane(PtyIds.TERMINAL_SURFACE, "t1", "p1")),
            session(PtyIds.pane("ws:w1", "t2", "p1"), running = false),
        )

        assertEquals(listOf("ws:w1/t1/p1", "ws:w1/t2/p1"), workspaceShells(sessions, "w1").map { it.id })
        assertTrue(agentRunning(sessions, "w1"))
        assertFalse(agentRunning(sessions, "w10"))
        assertFalse(agentRunning(listOf(session(PtyIds.agent("w1"), running = false)), "w1"))
    }

    @Test
    fun `the archive prefill prefers the recorded URL, then a merged PR, then an open one`() {
        fun repoWith(vararg prs: WorkspaceRepoPr) = workspaceRepo("api").copy(prs = prs.toList())
        val open = WorkspaceRepoPr(prNumber = 1, prUrl = "https://x/1", prState = "open")
        val closed = WorkspaceRepoPr(prNumber = 2, prUrl = "https://x/2", prState = "closed")
        val merged = WorkspaceRepoPr(prNumber = 3, prUrl = "https://x/3", prState = "merged")

        assertEquals("https://x/3", archivePrefillPrUrl(detail(repos = listOf(repoWith(open, merged)))))
        assertEquals("https://x/1", archivePrefillPrUrl(detail(repos = listOf(repoWith(closed, open)))))
        assertEquals("", archivePrefillPrUrl(detail(repos = listOf(repoWith(closed)))))
        assertEquals("https://kept", archivePrefillPrUrl(detail(repos = listOf(repoWith(merged))).copy(mergedPrUrl = "https://kept")))
    }

    @Test
    fun `a stuck archive names the repos that kept their worktree`() {
        val stuck = detail(
            status = "archiving",
            error = "1 worktree not removed",
            repos = listOf(workspaceRepo("api", status = "error", error = "uncommitted changes"), workspaceRepo("web", status = "error")),
        )

        assertEquals("api: uncommitted changes; web: worktree could not be removed", archiveBlockedText(stuck))
        assertEquals("1 worktree not removed", archiveBlockedText(stuck.copy(repos = emptyList())))
        assertNull(archiveBlockedText(stuck.copy(error = null)))
        assertEquals("Retry archive", archiveButtonLabel(stuck))
        assertEquals("Archiving…", archiveButtonLabel(stuck.copy(error = null)))
        assertEquals("Archive", archiveButtonLabel(detail()))
    }

    @Test
    fun `the archive description counts the open tasks it will mark done`() {
        val two = detail().copy(tasks = listOf(WorkspaceTask("t1", "A"), WorkspaceTask("t2", "B"), WorkspaceTask("t3", "C", status = "done")))

        assertTrue(archiveDescription(two).contains("and marks 2 linked tasks done."))
        assertFalse(archiveDescription(detail()).contains("marks"))
    }

    @Test
    fun `only issues not done here are offered for closing`() {
        val issues = listOf(
            IssueLink("todo", "github", "acme/api", "1", localStatus = "todo"),
            IssueLink("doing", "github", "acme/api", "2", localStatus = "in_progress"),
            IssueLink("done", "github", "acme/api", "3", localStatus = "done"),
            IssueLink("unknown", "jira", "site", "PROJ-4"),
        )

        assertEquals(listOf("todo", "doing", "unknown"), unfinishedIssues(detail().copy(issues = issues)).map { it.id })
    }

    @Test
    fun `a repo with no PR says whether the poller has looked yet`() {
        assertEquals("PR not polled yet", noPrLabel(workspaceRepo("api")))
        assertEquals("No PR yet", noPrLabel(workspaceRepo("api").copy(prsPolledAt = "2026-11-27T10:00:00Z")))
    }

    @Test
    fun `issue labels follow the tracker`() {
        assertEquals("acme/api#12", issueLinkLabel(IssueLink("i", "github", "acme/api", "12")))
        assertEquals("#678", issueLinkLabel(IssueLink("i", "azure", "org", "678")))
        assertEquals("PROJ-45", issueLinkLabel(IssueLink("i", "jira", "site", "PROJ-45")))
    }
}

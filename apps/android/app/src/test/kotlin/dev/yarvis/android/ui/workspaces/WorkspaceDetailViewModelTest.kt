package dev.yarvis.android.ui.workspaces

import dev.yarvis.android.MainDispatcherRule
import dev.yarvis.android.api.AgentConfig
import dev.yarvis.android.api.AgentHarness
import dev.yarvis.android.api.ArchiveRequest
import dev.yarvis.android.api.ProvisionEvent
import dev.yarvis.android.api.PtyIds
import java.io.IOException
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class WorkspaceDetailViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private val api = FakeWorkspacesApi()

    private fun viewModel() = WorkspaceDetailViewModel(api, api, "w1")

    @Test
    fun `with no agent running it offers a start, and the start opens the agent`() = runTest {
        api.details += detail()
        val vm = viewModel()
        advanceUntilIdle()
        assertFalse(vm.state.value.agentRunning)

        vm.openOrStartAgent()
        advanceUntilIdle()

        assertTrue("startAgent:w1:null" in api.calls)
        assertTrue(vm.state.value.agentRunning)
        assertEquals(TerminalTarget("ws-claude:w1", "Workspace w1 · Claude", "/ws/w1"), vm.pendingOpen.value)
        vm.opened()
        assertNull(vm.pendingOpen.value)
    }

    @Test
    fun `a running agent opens without starting another`() = runTest {
        api.details += detail()
        api.sessions += session(PtyIds.agent("w1"), kind = "agent")
        val vm = viewModel()
        advanceUntilIdle()

        vm.openOrStartAgent()

        assertEquals("ws-claude:w1", vm.pendingOpen.value?.sessionId)
        assertFalse(api.calls.any { it.startsWith("startAgent") })
    }

    @Test
    fun `with several harnesses the start sends the one picked`() = runTest {
        api.details += detail()
        api.config = AgentConfig(harnesses = listOf(AgentHarness("cc", "Claude"), AgentHarness("pi", "Pi")), defaultHarness = "cc")
        val vm = viewModel()
        advanceUntilIdle()
        assertTrue(vm.state.value.showsHarnessPicker)

        vm.pickHarness("pi")
        vm.openOrStartAgent()
        advanceUntilIdle()

        assertTrue("startAgent:w1:pi" in api.calls)
        assertEquals("Workspace w1 · Pi", vm.pendingOpen.value?.title)
        assertFalse(vm.state.value.showsHarnessPicker)
    }

    @Test
    fun `a failed start says so and opens nothing`() = runTest {
        api.details += detail()
        api.startFailure = IOException("no harness")
        val vm = viewModel()
        advanceUntilIdle()

        vm.openOrStartAgent()
        advanceUntilIdle()

        assertNull(vm.pendingOpen.value)
        assertEquals("Couldn't start the agent: no harness", vm.state.value.message)
        assertFalse(vm.state.value.agentBusy)
    }

    @Test
    fun `stopping kills the session, then tells the sidecar`() = runTest {
        api.details += detail()
        api.sessions += session(PtyIds.agent("w1"), kind = "agent")
        val vm = viewModel()
        advanceUntilIdle()

        vm.stopAgent()
        advanceUntilIdle()

        assertEquals(listOf("kill:ws-claude:w1", "stopAgent:w1"), api.calls.filter { it.startsWith("kill") || it.startsWith("stopAgent") })
        assertFalse(vm.state.value.agentRunning)
    }

    @Test
    fun `shells are this workspace's panes, and a new one is a fresh pane on its surface`() = runTest {
        api.details += detail()
        api.sessions += listOf(session("ws:w1/t1/p1"), session("ws:w2/t1/p1"), session("tab:terminal/t1/p1"), session(PtyIds.agent("w1")))
        val vm = viewModel()
        advanceUntilIdle()

        assertEquals(listOf("ws:w1/t1/p1"), vm.state.value.shells.map { it.id })
        assertEquals(TerminalTarget("ws:w1/t1/p1", "Workspace w1 · shell", "/ws/w1"), vm.shellTarget(vm.state.value.shells.single()))
        val fresh = vm.newShell()!!
        assertTrue(fresh.sessionId, Regex("ws:w1/t[0-9a-z]+/p[0-9a-z]+").matches(fresh.sessionId))
        assertEquals("/ws/w1", fresh.cwd)
    }

    @Test
    fun `a workspace being created follows its provision log, then reloads when it is done`() = runTest {
        api.details += detail(status = "creating", repos = listOf(workspaceRepo("api", status = "pending")))
        api.details += detail(status = "active", repos = listOf(workspaceRepo("api")))
        val vm = viewModel()
        advanceUntilIdle()
        assertTrue(vm.state.value.provisioning)
        assertEquals("", vm.state.value.provisionLog)

        api.emitProvision(ProvisionEvent.RepoStart("wr1", "api"))
        api.emitProvision(ProvisionEvent.Log("wr1", "cloning\n"))
        advanceUntilIdle()
        assertEquals("\n=== api ===\ncloning\n", vm.state.value.provisionLog)

        api.emitProvision(ProvisionEvent.RepoDone("wr1", "ready"))
        api.emitProvision(ProvisionEvent.Done("active"))
        advanceUntilIdle()

        assertFalse(vm.state.value.provisioning)
        assertNull(vm.state.value.provisionLog)
        assertEquals("active", vm.state.value.detail?.status)
        assertEquals(1, api.calls.count { it.startsWith("provision") })
    }

    @Test
    fun `a failed provision keeps its log up with the reason`() = runTest {
        api.details += detail(status = "creating")
        val vm = viewModel()
        advanceUntilIdle()

        api.emitProvision(ProvisionEvent.Log("wr1", "git clone failed\n"))
        api.emitProvision(ProvisionEvent.Error("clone failed"))
        advanceUntilIdle()

        assertFalse(vm.state.value.provisioning)
        assertEquals("git clone failed\n", vm.state.value.provisionLog)
        assertEquals("Provisioning failed: clone failed", vm.state.value.message)
        vm.closeProvisionLog()
        assertNull(vm.state.value.provisionLog)
    }

    @Test
    fun `an active workspace doesn't start a provision on open`() = runTest {
        api.details += detail()
        viewModel()
        advanceUntilIdle()

        assertFalse(api.calls.any { it.startsWith("provision") })
    }

    @Test
    fun `ignoring the error reloads the workspace`() = runTest {
        api.details += detail(status = "error", error = "setup failed", repos = listOf(workspaceRepo("api", status = "error")))
        api.details += detail(status = "active", repos = listOf(workspaceRepo("api", status = "error")))
        val vm = viewModel()
        advanceUntilIdle()

        vm.ignoreError()
        advanceUntilIdle()

        assertTrue("ignore:w1" in api.calls)
        assertEquals("active", vm.state.value.detail?.status)
    }

    @Test
    fun `archiving closes the dialog once started and reloads once`() = runTest {
        api.details += detail()
        api.details += detail(status = "archiving")
        val vm = viewModel()
        advanceUntilIdle()
        vm.openArchive()

        val request = ArchiveRequest(summary = "done", closeIssueIds = listOf("i1"))
        vm.archive(request)
        advanceUntilIdle()

        assertTrue("archive:w1:$request" in api.calls)
        assertFalse(vm.state.value.archiveDialogOpen)
        assertTrue(vm.state.value.detail!!.isTearingDown)
        assertEquals(2, api.calls.count { it.startsWith("workspace:") })
        assertFalse(vm.state.value.busy)
    }

    @Test
    fun `a failed archive start keeps the dialog open with the reason`() = runTest {
        api.details += detail()
        api.archiveFailure = IOException("409 provisioning")
        val vm = viewModel()
        advanceUntilIdle()
        vm.openArchive()

        vm.archive(ArchiveRequest())
        advanceUntilIdle()

        assertTrue(vm.state.value.archiveDialogOpen)
        assertEquals("Couldn't archive: 409 provisioning", vm.state.value.archiveError)
        assertFalse(vm.state.value.busy)
        vm.closeArchive()
        assertFalse(vm.state.value.archiveDialogOpen)
        assertNull(vm.state.value.archiveError)
    }

    @Test
    fun `resuming polls the workspace, faster during a teardown, and pausing stops it`() = runTest {
        api.details += detail()
        val vm = viewModel()
        advanceUntilIdle()
        fun loads() = api.calls.count { it.startsWith("workspace:") }

        vm.resume()
        runCurrent()
        assertEquals(2, loads())
        advanceTimeBy(20_001)
        assertEquals(3, loads())

        api.details[0] = detail(status = "archiving")
        advanceTimeBy(20_001)
        assertEquals(4, loads())
        advanceTimeBy(2_001)
        assertEquals(5, loads())

        vm.pause()
        advanceTimeBy(60_000)
        assertEquals(5, loads())
    }

    @Test
    fun `a provision stream that throws keeps the log and says why`() = runTest {
        api.details += detail(status = "creating")
        val vm = viewModel()
        advanceUntilIdle()

        api.emitProvision(ProvisionEvent.Log("wr1", "cloning\n"))
        api.provisionFailure(IOException("connection reset"))
        advanceUntilIdle()

        assertFalse(vm.state.value.provisioning)
        assertEquals("cloning\n", vm.state.value.provisionLog)
        assertEquals("Provisioning failed: connection reset", vm.state.value.message)
    }

    @Test
    fun `a provision stream that ends without done counts as finished`() = runTest {
        api.details += detail(status = "creating")
        api.details += detail(status = "active")
        val vm = viewModel()
        advanceUntilIdle()

        api.emitProvision(ProvisionEvent.Log("wr1", "cloning\n"))
        api.endProvision()
        advanceUntilIdle()

        assertFalse(vm.state.value.provisioning)
        assertNull(vm.state.value.provisionLog)
        assertNull(vm.state.value.message)
        assertEquals("active", vm.state.value.detail?.status)
    }

    @Test
    fun `a second provision during a run follows the same stream`() = runTest {
        api.details += detail(status = "creating")
        val vm = viewModel()
        advanceUntilIdle()

        vm.provision()
        vm.provision()
        advanceUntilIdle()

        assertEquals(1, api.calls.count { it.startsWith("provision") })
        assertTrue(vm.state.value.provisioning)
    }

    @Test
    fun `the provision log keeps its tail`() = runTest {
        api.details += detail(status = "creating")
        val vm = viewModel()
        advanceUntilIdle()

        val line = "x".repeat(99) + "\n"
        repeat(1_000) { api.emitProvision(ProvisionEvent.Log("wr1", line)) }
        api.emitProvision(ProvisionEvent.Log("wr1", "last\n"))
        advanceUntilIdle()

        val log = vm.state.value.provisionLog!!
        assertTrue(log.length <= 64 * 1024)
        assertTrue(log.startsWith("x"))
        assertTrue(log.endsWith("last\n"))
    }
}

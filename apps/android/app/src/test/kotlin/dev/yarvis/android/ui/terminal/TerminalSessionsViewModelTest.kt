package dev.yarvis.android.ui.terminal

import dev.yarvis.android.MainDispatcherRule
import dev.yarvis.android.api.AgentHarness
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.IOException

class TerminalSessionsViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private val api = FakePtyApi()

    @Test
    fun `lists agents before shells`() = runTest {
        api.sessions += session("tab:terminal/t1/p1", cwd = "/src/app")
        api.sessions += session("ws-claude:w1", kind = "agent", workspaceId = "w1")
        val vm = TerminalSessionsViewModel(api)
        vm.refresh()

        val sections = vm.state.value.sections
        assertEquals(listOf("Agents", "Shells"), sections.map { it.first })
        assertEquals("ws-claude:w1", sections[0].second.single().id)
        assertFalse(vm.state.value.loading)
    }

    @Test
    fun `a failed load is shown`() = runTest {
        api.listError = IOException("offline")
        val vm = TerminalSessionsViewModel(api)
        vm.refresh()

        assertNotNull(vm.state.value.error)
        assertFalse(vm.state.value.loading)
    }

    @Test
    fun `killing a session ends it and drops it from the list`() = runTest {
        api.sessions += session("a")
        api.sessions += session("b")
        val vm = TerminalSessionsViewModel(api)
        vm.refresh()

        vm.kill("a")

        assertEquals(listOf("a"), api.killed)
        assertEquals(listOf("b"), vm.state.value.sessions.map { it.id })
    }

    @Test
    fun `titles name the harness and workspace, or the shell's folder`() {
        val agent = session("ws-claude:w1", kind = "agent", workspaceId = "w1").copy(harness = AgentHarness("h", "Claude Code"))
        assertEquals("Claude Code · w1", sessionTitle(agent))
        assertEquals("app", sessionTitle(session("s", cwd = "/src/app/")))
        assertEquals("Home", sessionTitle(session("s")))
        assertTrue(sessionDetail(session("s", running = false).copy(exitCode = 2)).startsWith("Exited (2)"))
    }
}

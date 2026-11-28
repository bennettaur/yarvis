package dev.yarvis.android.ui.workspaces

import dev.yarvis.android.MainDispatcherRule
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

class WorkspaceListViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private val api = FakeWorkspacesApi()

    @Test
    fun `resuming loads the list with badges and groups it, archived hidden`() = runTest {
        api.list = listOf(
            summary("b", repoNames = listOf("web")),
            summary("a", repoNames = listOf("api")),
            summary("old", repoNames = listOf("api"), status = "archived"),
        )
        val vm = WorkspaceListViewModel(api)
        vm.resume()
        runCurrent()
        vm.pause()

        assertEquals(listOf("workspaces:true"), api.calls)
        val state = vm.state.value
        assertFalse(state.loading)
        assertEquals(listOf("api", "web"), state.groups.map { it.label })
        assertEquals(listOf("a"), state.groups[0].workspaces.map { it.id })
        assertEquals(1, state.archivedCount)

        vm.toggleArchived()
        assertEquals(listOf("a", "old"), vm.state.value.groups[0].workspaces.map { it.id })
    }

    @Test
    fun `it polls while resumed, faster during a teardown, and stops when paused`() = runTest {
        api.list = listOf(summary("a"))
        val vm = WorkspaceListViewModel(api)
        vm.resume()
        runCurrent()
        advanceTimeBy(20_001)
        assertEquals(2, api.calls.size)

        api.list = listOf(summary("a", status = "archiving"))
        advanceTimeBy(20_001)
        assertEquals(3, api.calls.size)
        advanceTimeBy(2_001)
        assertEquals(4, api.calls.size)

        vm.pause()
        advanceTimeBy(60_000)
        assertEquals(4, api.calls.size)
    }

    @Test
    fun `a failed background poll keeps the list, a pull to refresh shows the failure`() = runTest {
        api.list = listOf(summary("a"))
        val vm = WorkspaceListViewModel(api)
        vm.resume()
        runCurrent()
        vm.pause()

        api.listFailure = IOException("offline")
        vm.resume()
        runCurrent()
        vm.pause()
        assertNull(vm.state.value.error)
        assertEquals(listOf("a"), vm.state.value.workspaces.map { it.id })

        vm.refresh()
        advanceUntilIdle()
        assertTrue(vm.state.value.error!!.contains("offline"))
        assertEquals(listOf("a"), vm.state.value.workspaces.map { it.id })
    }

    @Test
    fun `a first load that fails says so`() = runTest {
        api.listFailure = IOException("offline")
        val vm = WorkspaceListViewModel(api)
        vm.resume()
        runCurrent()
        vm.pause()

        assertEquals("Couldn't load workspaces: offline", vm.state.value.error)
        assertFalse(vm.state.value.loading)
    }
}

package dev.yarvis.android.ui.workspaces

import dev.yarvis.android.MainDispatcherRule
import dev.yarvis.android.api.NewWorkspace
import dev.yarvis.android.api.ReauthCancelledException
import dev.yarvis.android.api.WorkspaceTask
import java.io.IOException
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class NewWorkspaceViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private val api = FakeWorkspacesApi().apply {
        repos = listOf(repo("r1", "api"), repo("r2", "web"))
        branches = mapOf("r1" to listOf("main", "feature/x"))
        tasks = listOf(WorkspaceTask("t1", "Ship it"))
    }

    @Test
    fun `it loads the repos and open tasks`() = runTest {
        val vm = NewWorkspaceViewModel(api)
        advanceUntilIdle()

        assertEquals(listOf("api", "web"), vm.state.value.repos.map { it.name })
        assertEquals(listOf("t1"), vm.state.value.tasks.map { it.id })
        assertFalse(vm.state.value.reposLoading)
    }

    @Test
    fun `a blank name is refused before anything is sent`() = runTest {
        val vm = NewWorkspaceViewModel(api)
        vm.setName("   ")
        vm.create()

        assertEquals("Pick a name.", vm.state.value.error)
        assertFalse(api.calls.any { it.startsWith("create") })
    }

    @Test
    fun `ticking a repo loads its branches once, and a failure can be retried`() = runTest {
        val vm = NewWorkspaceViewModel(api)
        advanceUntilIdle()

        vm.toggle("r1")
        vm.toggle("r2")
        advanceUntilIdle()
        assertEquals(Branches.Loaded(listOf("main", "feature/x")), vm.state.value.branches["r1"])
        assertTrue(vm.state.value.branches["r2"] is Branches.Failed)

        vm.toggle("r1")
        vm.toggle("r1")
        advanceUntilIdle()
        assertEquals(1, api.calls.count { it == "branches:r1" })

        vm.toggle("r2")
        vm.toggle("r2")
        advanceUntilIdle()
        assertEquals(2, api.calls.count { it == "branches:r2" })
    }

    @Test
    fun `submit sends the trimmed name, ticked repos in list order, their picked branches and the task`() = runTest {
        val vm = NewWorkspaceViewModel(api)
        advanceUntilIdle()
        vm.setName("  rename the API ")
        vm.toggle("r2")
        vm.toggle("r1")
        advanceUntilIdle()
        vm.chooseBranch("r1", "feature/x")
        vm.chooseBranch("r2", "main")
        // A branch picked for a repo later unticked is left out.
        vm.toggle("r2")
        vm.setTask("t1")

        vm.create()
        advanceUntilIdle()

        val sent = NewWorkspace(name = "rename the API", repoIds = listOf("r1"), existingBranches = mapOf("r1" to "feature/x"), taskId = "t1")
        assertEquals("create:$sent", api.calls.single { it.startsWith("create") })
        assertEquals("new-1", vm.state.value.created?.id)
        assertNull(vm.state.value.error)
    }

    @Test
    fun `a scratch workspace sends no repos and no branches`() = runTest {
        val vm = NewWorkspaceViewModel(api)
        advanceUntilIdle()
        vm.setName("explore")

        vm.create()
        advanceUntilIdle()

        assertEquals("create:${NewWorkspace(name = "explore", repoIds = emptyList())}", api.calls.single { it.startsWith("create") })
    }

    @Test
    fun `a failed create shows why and can be sent again`() = runTest {
        api.createFailure = IOException("name taken")
        val vm = NewWorkspaceViewModel(api)
        advanceUntilIdle()
        vm.setName("x")

        vm.create()
        advanceUntilIdle()
        assertEquals("name taken", vm.state.value.error)
        assertFalse(vm.state.value.busy)

        api.createFailure = null
        vm.create()
        advanceUntilIdle()
        assertEquals("new-1", vm.state.value.created?.id)
    }

    @Test
    fun `closing the code prompt cancels quietly`() = runTest {
        api.createFailure = ReauthCancelledException()
        val vm = NewWorkspaceViewModel(api)
        advanceUntilIdle()
        vm.setName("x")

        vm.create()
        advanceUntilIdle()

        assertNull(vm.state.value.error)
        assertFalse(vm.state.value.busy)
    }
}

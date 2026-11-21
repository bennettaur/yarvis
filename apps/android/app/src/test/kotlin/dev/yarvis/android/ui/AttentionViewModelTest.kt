package dev.yarvis.android.ui

import dev.yarvis.android.FakeAttentionApi
import dev.yarvis.android.MainDispatcherRule
import dev.yarvis.android.api.AgentQuestion
import dev.yarvis.android.api.ApiException
import dev.yarvis.android.api.HeadsDownAnswer
import dev.yarvis.android.api.HeadsDownQuestion
import dev.yarvis.android.api.PermissionDecision
import dev.yarvis.android.api.PermissionRequest
import dev.yarvis.android.api.QuestionAnswer
import dev.yarvis.android.api.QuestionContext
import dev.yarvis.android.api.QuestionItem
import dev.yarvis.android.api.QuestionOption
import dev.yarvis.android.api.ReauthCancelledException
import dev.yarvis.android.approval
import dev.yarvis.android.data.AttentionRepository
import dev.yarvis.android.item
import dev.yarvis.android.ui.attention.AttentionViewModel
import dev.yarvis.android.ui.attention.ItemDetail
import dev.yarvis.android.ui.attention.permissionAnswers
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class AttentionViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private val api = FakeAttentionApi()

    private fun TestScope.viewModel(): Pair<AttentionViewModel, AttentionRepository> {
        val repo = AttentionRepository(api, { emptyFlow() }, backgroundScope, onSignedOut = {})
        return AttentionViewModel(api, repo) to repo
    }

    private fun permission(id: String, key: String = "ws-1:claude") =
        PermissionRequest(id = id, sessionKey = key, toolName = "Bash", createdAt = "")

    private fun question(id: String) = AgentQuestion(
        id = id,
        sessionKey = "ws-1:claude",
        context = QuestionContext("Pick a branch"),
        questions = listOf(QuestionItem("Which branch?", options = listOf(QuestionOption("main"), QuestionOption("dev")))),
        status = "pending",
        createdAt = "",
    )

    @Test
    fun `opening a permission item loads that session's prompts`() = runTest {
        api.permissionList += listOf(permission("r1"), permission("r9", key = "other"))
        val (vm, _) = viewModel()
        vm.openItem(item("a1", 1, kind = "permission", sessionKey = "ws-1:claude", source = "claude-hook"))
        advanceUntilIdle()

        val detail = vm.opened.value!!.detail as ItemDetail.Permissions
        assertEquals(listOf("r1"), detail.requests.map { it.id })
    }

    @Test
    fun `answering the last prompt closes the item and drops it from the list`() = runTest {
        api.pending += item("a1", 1, kind = "permission", sessionKey = "ws-1:claude", source = "claude-hook")
        api.permissionList += permission("r1")
        val (vm, repo) = viewModel()
        repo.reloadAttention()
        vm.openItem(api.pending.single())
        advanceUntilIdle()

        vm.decidePermission(api.permissionList.single(), PermissionDecision.Allow)
        advanceUntilIdle()

        assertEquals(listOf("permission:r1:Allow"), api.calls)
        assertNull(vm.opened.value)
        assertTrue(repo.state.value.items.isEmpty())
    }

    @Test
    fun `a prompt the terminal already answered says so`() = runTest {
        api.permissionList += permission("r1")
        api.delivered = false
        val (vm, _) = viewModel()
        vm.openItem(item("a1", 1, kind = "permission", sessionKey = "ws-1:claude", source = "claude-hook"))
        advanceUntilIdle()

        vm.decidePermission(permission("r1"), PermissionDecision.Deny())
        advanceUntilIdle()

        assertEquals("That prompt was already answered in the terminal.", vm.message.value)
    }

    @Test
    fun `answering one of two questions keeps the item open on the other`() = runTest {
        api.questionList += listOf(question("q1"), question("q2"))
        val (vm, _) = viewModel()
        vm.openItem(item("a1", 1, kind = "question", sessionKey = "ws-1:claude"))
        advanceUntilIdle()

        vm.answerQuestion(question("q1"), listOf(QuestionAnswer(listOf("main"))))
        advanceUntilIdle()

        assertEquals(listOf("answer:q1:[[main]]"), api.calls)
        val detail = vm.opened.value!!.detail as ItemDetail.Questions
        assertEquals(listOf("q2"), detail.questions.map { it.id })
    }

    @Test
    fun `a server approval another device answered first is reported, not an error`() = runTest {
        api.pendingApprovals += approval("ap1")
        api.approvalError = ApiException(409, "already answered", "approved by device Laptop")
        val (vm, repo) = viewModel()
        repo.reloadApprovals()

        vm.answerApproval(approval("ap1"), approve = true)
        advanceUntilIdle()

        assertEquals("approved by device Laptop", vm.message.value)
        assertTrue(repo.state.value.approvals.isEmpty())
    }

    @Test
    fun `closing the code prompt sends nothing and shows nothing`() = runTest {
        api.pendingApprovals += approval("ap1")
        api.approvalError = ReauthCancelledException()
        val (vm, repo) = viewModel()
        repo.reloadApprovals()

        vm.answerApproval(approval("ap1"), approve = true)
        advanceUntilIdle()

        assertNull(vm.message.value)
        assertEquals(listOf("ap1"), repo.state.value.approvals.map { it.id })
    }

    @Test
    fun `dismiss marks the item dismissed and removes it`() = runTest {
        api.pending += item("a1", 1)
        val (vm, repo) = viewModel()
        repo.reloadAttention()

        vm.dismiss(api.pending.single())
        advanceUntilIdle()

        assertEquals(listOf("status:a1:dismissed"), api.calls)
        assertTrue(repo.state.value.items.isEmpty())
    }

    @Test
    fun `a heads-down item loads its question, and answering closes it`() = runTest {
        api.headsDown = HeadsDownQuestion(id = "h1", kind = "approval", question = "Merge #12?", options = listOf("approve", "deny"), status = "open", createdAt = "")
        api.pending += item("a1", 1, kind = "permission", sessionKey = "heads-down:h1")
        val (vm, repo) = viewModel()
        repo.reloadAttention()
        vm.openItem(api.pending.single())
        advanceUntilIdle()
        assertEquals("h1", (vm.opened.value!!.detail as ItemDetail.HeadsDown).question!!.id)

        vm.answerHeadsDown(api.headsDown!!, HeadsDownAnswer(choice = "approve"))
        advanceUntilIdle()

        assertEquals(listOf("headsdown:h1:approve"), api.calls)
        assertNull(vm.opened.value)
        assertTrue(repo.state.value.items.isEmpty())
    }

    @Test
    fun `a detail that fails to load says so`() = runTest {
        api.detailError = java.io.IOException("timeout")
        val (vm, _) = viewModel()
        vm.openItem(item("a1", 1, kind = "permission", sessionKey = "heads-down:h1"))
        advanceUntilIdle()

        assertEquals(ItemDetail.Failed("timeout"), vm.opened.value!!.detail)
    }

    @Test
    fun `declining a question tells the agent and closes the item`() = runTest {
        api.questionList += question("q1")
        val (vm, _) = viewModel()
        vm.openItem(item("a1", 1, kind = "question", sessionKey = "ws-1:claude"))
        advanceUntilIdle()

        api.questionList.clear()
        vm.declineQuestion(question("q1"))
        advanceUntilIdle()

        assertEquals(listOf("decline:q1"), api.calls)
        assertNull(vm.opened.value)
    }

    @Test
    fun `any other approval failure is shown`() = runTest {
        api.approvalError = ApiException(500, "internal error")
        val (vm, _) = viewModel()
        vm.answerApproval(approval("ap1"), approve = true)
        advanceUntilIdle()

        assertTrue(vm.message.value!!.startsWith("Couldn't send that"))
    }

    @Test
    fun `AskUserQuestion answers are keyed by question text, picks joined as the web does`() {
        val questions = listOf(
            QuestionItem("Which files?", multiSelect = true),
            QuestionItem("Anything else?"),
        )
        val answers = listOf(QuestionAnswer(listOf("a.kt", "b.kt"), "and tests"), QuestionAnswer(emptyList(), " no "))

        assertEquals(
            mapOf("Which files?" to "a.kt, b.kt\nand tests", "Anything else?" to "no"),
            permissionAnswers(questions, answers),
        )
    }
}

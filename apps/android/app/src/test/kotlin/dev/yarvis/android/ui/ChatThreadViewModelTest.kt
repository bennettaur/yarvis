package dev.yarvis.android.ui

import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.yarvis.android.FakeChatApi
import dev.yarvis.android.FakePrefs
import dev.yarvis.android.MainDispatcherRule
import dev.yarvis.android.api.ApiException
import dev.yarvis.android.api.ChatEvent
import dev.yarvis.android.api.ChatMessage
import dev.yarvis.android.api.ReauthCancelledException
import dev.yarvis.android.data.ChatModelChoice
import dev.yarvis.android.data.ChatTurns
import dev.yarvis.android.ui.chat.ChatThreadViewModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class ChatThreadViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private val api = FakeChatApi()
    private val prefs = FakePrefs()
    private var turns: ChatTurns? = null

    // The turns' own scope, as the app's live in the session's. Not backgroundScope: advanceUntilIdle doesn't run its work.
    private val scope = CoroutineScope(SupervisorJob())

    @After
    fun stopTurns() = scope.cancel()

    private fun TestScope.thread(
        sessionId: String?,
        threadKey: String = sessionId ?: "new:a",
        store: ViewModelStore = ViewModelStore(),
    ): ChatThreadViewModel {
        val shared = turns ?: ChatTurns(api, CoroutineScope(scope.coroutineContext + main.dispatcher)).also { turns = it }
        return ViewModelProvider.create(
            store,
            viewModelFactory { initializer { ChatThreadViewModel(api, prefs, shared, sessionId, threadKey) } },
        )[threadKey, ChatThreadViewModel::class]
    }

    @Test
    fun `picks the saved model, or the first available provider's first model`() = runTest {
        val fresh = thread(sessionId = null)
        advanceUntilIdle()
        assertEquals("anthropic" to "claude-sonnet-5-5", fresh.state.value.provider to fresh.state.value.model)

        prefs.saved = ChatModelChoice("anthropic", "claude-opus-5-5")
        val remembered = thread(sessionId = null, threadKey = "new:b")
        advanceUntilIdle()
        assertEquals("claude-opus-5-5", remembered.state.value.model)
    }

    @Test
    fun `a first message creates the session, streams the reply and reloads the saved thread`() = runTest {
        val vm = thread(sessionId = null)
        advanceUntilIdle()

        vm.send("  What's on today?  ")
        advanceUntilIdle()
        assertEquals("new-1", vm.state.value.sessionId)
        assertEquals("What's on today?", api.requests.single().message)
        assertEquals("", vm.state.value.streaming)
        assertEquals("What's on today?", vm.state.value.pendingMessage)

        api.turnEvents.send(ChatEvent(type = "delta", text = "Two "))
        api.turnEvents.send(ChatEvent(type = "tool_call", id = "c1", name = "list_events", server = "calendar"))
        advanceUntilIdle()
        assertEquals("Two ", vm.state.value.streaming)
        assertEquals("pending", vm.state.value.activity.single().status)

        api.turnEvents.send(ChatEvent(type = "tool_result", id = "c1", status = "ok", result = "2 events", durationMs = 300))
        api.turnEvents.send(ChatEvent(type = "delta", text = "meetings."))
        api.stored += ChatMessage("m1", "new-1", "user", "What's on today?", null, "")
        api.stored += ChatMessage("m2", "new-1", "assistant", "Two meetings.", null, "")
        api.turnEvents.send(ChatEvent(type = "done", finishReason = "stop", steps = 2))
        api.turnEvents.close()
        advanceUntilIdle()

        val s = vm.state.value
        assertFalse(s.running)
        assertNull(s.pendingMessage)
        assertEquals(listOf("user", "assistant"), s.messages.map { it.role })
        assertEquals("Two meetings.", s.messages.last().content)
    }

    @Test
    fun `leaving the thread doesn't stop its turn, and reopening it shows the turn`() = runTest {
        val store = ViewModelStore()
        val first = thread(sessionId = null, store = store)
        advanceUntilIdle()
        first.send("Summarise my PRs")
        api.turnEvents.send(ChatEvent(type = "delta", text = "You have "))
        advanceUntilIdle()

        store.clear()
        api.turnEvents.send(ChatEvent(type = "delta", text = "three."))
        advanceUntilIdle()

        // The list opens a new chat's thread by its session id once it has one.
        val reopened = thread(sessionId = "new-1")
        advanceUntilIdle()
        assertTrue(reopened.state.value.running)
        assertEquals("You have three.", reopened.state.value.streaming)

        api.stored += ChatMessage("m1", "new-1", "user", "Summarise my PRs", null, "")
        api.stored += ChatMessage("m2", "new-1", "assistant", "You have three.", null, "")
        api.turnEvents.close()
        advanceUntilIdle()
        assertFalse(reopened.state.value.running)
        assertEquals(listOf("user", "assistant"), reopened.state.value.messages.map { it.role })
    }

    @Test
    fun `tool approvals queue in order and leave the bar once answered`() = runTest {
        val vm = thread(sessionId = "s1")
        advanceUntilIdle()
        vm.send("File two bugs")
        api.turnEvents.send(ChatEvent(type = "tool_approval_request", id = "c1", name = "create_issue", server = "GitHub", reason = "asked"))
        api.turnEvents.send(ChatEvent(type = "tool_approval_request", id = "c2", name = "create_issue", server = "GitHub"))
        api.turnEvents.send(ChatEvent(type = "tool_approval_request", id = "c1", name = "create_issue", server = "GitHub"))
        advanceUntilIdle()
        assertEquals(listOf("c1", "c2"), vm.state.value.approvals.map { it.id })

        vm.answerApproval(vm.state.value.approvals.first(), approved = true)
        advanceUntilIdle()

        assertEquals(listOf("c1" to true), api.approvalAnswers)
        assertEquals(listOf("c2"), vm.state.value.approvals.map { it.id })
    }

    @Test
    fun `an approval stays when the user closes the code prompt`() = runTest {
        val vm = thread(sessionId = "s1")
        advanceUntilIdle()
        vm.send("Do it")
        api.turnEvents.send(ChatEvent(type = "tool_approval_request", id = "c1", name = "deploy", server = ""))
        advanceUntilIdle()
        api.approvalError = ReauthCancelledException()

        vm.answerApproval(vm.state.value.approvals.single(), approved = true)
        advanceUntilIdle()

        assertEquals(1, vm.state.value.approvals.size)
        assertNull(vm.state.value.error)
    }

    @Test
    fun `stop drops the partial reply and says so without an error`() = runTest {
        val vm = thread(sessionId = "s1")
        advanceUntilIdle()
        vm.send("Write an essay")
        api.turnEvents.send(ChatEvent(type = "delta", text = "Once upon"))
        api.turnEvents.send(ChatEvent(type = "tool_approval_request", id = "c1", name = "x", server = ""))
        advanceUntilIdle()
        assertTrue(vm.state.value.running)

        vm.stop()
        advanceUntilIdle()

        val s = vm.state.value
        assertFalse(s.running)
        assertEquals(listOf("user"), s.messages.map { it.role })
        assertTrue(s.approvals.isEmpty())
        assertNull(s.error)
        assertNull(s.failure)
        assertEquals("Turn stopped. Nothing was saved for it.", s.notice)
        // The stream was dropped, so a late frame changes nothing.
        api.turnEvents.send(ChatEvent(type = "delta", text = "late"))
        advanceUntilIdle()
        assertNull(vm.state.value.streaming)
    }

    @Test
    fun `an error event fails the turn and keeps no partial reply`() = runTest {
        val vm = thread(sessionId = "s1")
        advanceUntilIdle()
        vm.send("Hi")
        api.turnEvents.send(ChatEvent(type = "delta", text = "Hel"))
        api.turnEvents.send(ChatEvent(type = "error", message = "The provider refused the request", detail = "429"))
        api.turnEvents.close()
        advanceUntilIdle()

        val s = vm.state.value
        assertFalse(s.running)
        assertEquals("The provider refused the request\n\n429", s.failure)
        assertNull(s.error)
        assertTrue(s.messages.none { it.role == "assistant" })
        assertEquals("Hi", s.pendingMessage)
    }

    @Test
    fun `retry sends the same text again, collapsed onto the saved message`() = runTest {
        api.streamError = ApiException(503, "database not configured")
        val vm = thread(sessionId = "s1")
        advanceUntilIdle()
        // The sidecar saves the user's message before the turn fails.
        api.stored += ChatMessage("m1", "s1", "user", "Hi", null, "")
        vm.send("Hi")
        advanceUntilIdle()
        assertTrue(vm.state.value.failure!!.contains("database not configured"))

        api.streamError = null
        vm.retry()
        advanceUntilIdle()

        assertEquals(listOf("Hi"), api.requests.map { it.message })
        assertTrue(vm.state.value.running)
        assertNull(vm.state.value.failure)
        // The sidecar saved the first attempt's message, so the retry isn't shown twice.
        assertEquals(listOf("user"), vm.state.value.messages.map { it.role })
        assertNull(vm.state.value.pendingMessage)
    }

    @Test
    fun `with no model on the server nothing is sent`() = runTest {
        api.providerList.clear()
        val vm = thread(sessionId = "s1")
        advanceUntilIdle()
        vm.send("Hi")
        advanceUntilIdle()

        assertTrue(api.requests.isEmpty())
        assertEquals("No chat model is set up on the server.", vm.state.value.error)
    }

    @Test
    fun `choosing a model remembers it`() = runTest {
        val vm = thread(sessionId = null)
        advanceUntilIdle()
        vm.chooseModel("anthropic", "claude-opus-5-5")
        advanceUntilIdle()

        assertEquals(ChatModelChoice("anthropic", "claude-opus-5-5"), prefs.saved)
    }

    @Test
    fun `a failed approval answer keeps the approval and says why`() = runTest {
        val vm = thread(sessionId = "s1")
        advanceUntilIdle()
        vm.send("Do it")
        api.turnEvents.send(ChatEvent(type = "tool_approval_request", id = "c1", name = "deploy", server = ""))
        advanceUntilIdle()
        api.approvalError = ApiException(403, "this device doesn't have the approve scope")

        vm.answerApproval(vm.state.value.approvals.single(), approved = true)
        advanceUntilIdle()

        assertEquals(1, vm.state.value.approvals.size)
        assertTrue(vm.state.value.error!!.contains("approve scope"))
    }

    @Test
    fun `no message is sent while a turn runs`() = runTest {
        val vm = thread(sessionId = "s1")
        advanceUntilIdle()
        vm.send("one")
        vm.send("two")
        advanceUntilIdle()
        assertEquals(listOf("one"), api.requests.map { it.message })
    }
}

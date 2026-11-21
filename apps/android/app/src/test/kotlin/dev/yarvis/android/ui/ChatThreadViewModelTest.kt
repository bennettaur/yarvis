package dev.yarvis.android.ui

import dev.yarvis.android.FakeChatApi
import dev.yarvis.android.FakePrefs
import dev.yarvis.android.MainDispatcherRule
import dev.yarvis.android.api.ChatEvent
import dev.yarvis.android.api.ChatMessage
import dev.yarvis.android.api.ReauthCancelledException
import dev.yarvis.android.ui.chat.ChatThreadViewModel
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
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

    @Test
    fun `picks the saved model, or the first available provider's first model`() = runTest {
        val fresh = ChatThreadViewModel(api, prefs, sessionId = null)
        advanceUntilIdle()
        assertEquals("anthropic" to "claude-sonnet-5-5", fresh.state.value.provider to fresh.state.value.model)

        prefs.saved = "anthropic" to "claude-opus-5-5"
        val remembered = ChatThreadViewModel(api, prefs, sessionId = null)
        advanceUntilIdle()
        assertEquals("claude-opus-5-5", remembered.state.value.model)
    }

    @Test
    fun `a first message creates the session, streams the reply and reloads the saved thread`() = runTest {
        val vm = ChatThreadViewModel(api, prefs, sessionId = null)
        advanceUntilIdle()

        vm.send("  What's on today?  ")
        advanceUntilIdle()
        assertEquals("new-1", vm.state.value.sessionId)
        assertEquals("What's on today?", api.requests.single().message)
        assertEquals("", vm.state.value.streaming)

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
        assertEquals(listOf("user", "assistant"), s.messages.map { it.role })
        assertEquals("Two meetings.", s.messages.last().content)
    }

    @Test
    fun `tool approvals queue in order and leave the bar once answered`() = runTest {
        val vm = ChatThreadViewModel(api, prefs, sessionId = "s1")
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
        val vm = ChatThreadViewModel(api, prefs, sessionId = "s1")
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
        val vm = ChatThreadViewModel(api, prefs, sessionId = "s1")
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
        assertEquals("Turn stopped. Nothing was saved for it.", s.notice)
        // The stream was dropped: nothing reads the turn's channel anymore.
        assertTrue(api.turnEvents.trySend(ChatEvent(type = "delta", text = "late")).isSuccess)
        advanceUntilIdle()
        assertNull(vm.state.value.streaming)
    }

    @Test
    fun `an error event shows the message and keeps no partial reply`() = runTest {
        val vm = ChatThreadViewModel(api, prefs, sessionId = "s1")
        advanceUntilIdle()
        vm.send("Hi")
        api.turnEvents.send(ChatEvent(type = "delta", text = "Hel"))
        api.turnEvents.send(ChatEvent(type = "error", message = "The provider refused the request", detail = "429"))
        api.turnEvents.close()
        advanceUntilIdle()

        val s = vm.state.value
        assertFalse(s.running)
        assertEquals("The provider refused the request\n\n429", s.error)
        assertTrue(s.messages.none { it.role == "assistant" })
    }

    @Test
    fun `no message is sent while a turn runs`() = runTest {
        val vm = ChatThreadViewModel(api, prefs, sessionId = "s1")
        advanceUntilIdle()
        vm.send("one")
        vm.send("two")
        advanceUntilIdle()
        assertEquals(listOf("one"), api.requests.map { it.message })
    }
}

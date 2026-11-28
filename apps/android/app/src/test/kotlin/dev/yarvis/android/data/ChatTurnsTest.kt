package dev.yarvis.android.data

import dev.yarvis.android.FakeChatApi
import dev.yarvis.android.api.ChatEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatTurnsTest {
    private val api = FakeChatApi()
    private val scope = CoroutineScope(SupervisorJob())

    // Not backgroundScope: advanceUntilIdle doesn't run its work, and the turns run on their own.
    private fun TestScope.turns() = ChatTurns(api, CoroutineScope(scope.coroutineContext + StandardTestDispatcher(testScheduler)))

    @After
    fun stopTurns() = scope.cancel()

    @Test
    fun `a new chat's turn is found by its first key and then its session id`() = runTest {
        val turns = turns()
        assertTrue(turns.send("new:a", null, "Hi", "anthropic", "m"))
        advanceUntilIdle()

        assertEquals("new-1", turns.turn("new:a").first()?.sessionId)
        assertEquals("Hi", turns.turn("new-1").first()?.text)
        assertEquals(setOf("new-1"), turns.replying.first())
    }

    @Test
    fun `a finished turn is dropped`() = runTest {
        val turns = turns()
        turns.send("s1", "s1", "Hi", "anthropic", "m")
        api.turnEvents.send(ChatEvent(type = "delta", text = "Hello"))
        api.turnEvents.close()
        advanceUntilIdle()

        assertNull(turns.turn("s1").first())
        assertTrue(turns.replying.first().isEmpty())
    }

    @Test
    fun `stop ends only that thread's turn`() = runTest {
        val turns = turns()
        turns.send("s1", "s1", "Hi", "anthropic", "m")
        advanceUntilIdle()

        assertFalse(turns.stop("s2"))
        assertTrue(turns.stop("s1"))
        advanceUntilIdle()
        assertNull(turns.turn("s1").first())
    }

    @Test
    fun `sign-out stops every turn`() = runTest {
        val turns = turns()
        turns.send("s1", "s1", "one", "anthropic", "m")
        turns.send("s2", "s2", "two", "anthropic", "m")
        advanceUntilIdle()
        assertEquals(setOf("s1", "s2"), turns.replying.first())

        turns.stopAll()
        api.turnEvents.send(ChatEvent(type = "delta", text = "late"))
        advanceUntilIdle()

        assertTrue(turns.replying.first().isEmpty())
        assertNull(turns.turn("s1").first())
        assertNull(turns.turn("s2").first())
    }

    @Test
    fun `a failure stays until the thread sends again or dismisses it`() = runTest {
        val turns = turns()
        turns.send("s1", "s1", "Hi", "anthropic", "m")
        api.turnEvents.send(ChatEvent(type = "tool_approval_request", id = "c1", name = "x", server = ""))
        api.turnEvents.send(ChatEvent(type = "error", message = "refused"))
        api.turnEvents.close()
        advanceUntilIdle()

        val failed = turns.turn("s1").first()!!
        assertEquals("refused", failed.failure)
        // An approval can't be answered after its turn.
        assertTrue(failed.approvals.isEmpty())

        turns.dismissFailure("s1")
        assertNull(turns.turn("s1").first())
    }
}

package dev.yarvis.android.data

import dev.yarvis.android.FakeAttentionApi
import dev.yarvis.android.api.EventsSignal
import dev.yarvis.android.api.ServerEvent
import dev.yarvis.android.api.UnauthorizedException
import dev.yarvis.android.approval
import dev.yarvis.android.item
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AttentionRepositoryTest {
    private val api = FakeAttentionApi()
    private val events = Channel<EventsSignal>(Channel.UNLIMITED)
    private var signedOut = 0

    private fun TestScope.repository(): Pair<AttentionRepository, MutableList<Arrival>> {
        val repo = AttentionRepository(api, { events.receiveAsFlow() }, backgroundScope, onSignedOut = { signedOut++ })
        val arrivals = mutableListOf<Arrival>()
        backgroundScope.launch { repo.arrivals.collect { arrivals += it } }
        runCurrent()
        return repo to arrivals
    }

    private fun event(kind: String, seq: Long = 1) = EventsSignal.Event(ServerEvent(seq, 0, null, kind, null))

    @Test
    fun `loads pending items newest first without announcing them`() = runTest {
        api.pending += listOf(item("a", 1), item("b", 3), item("c", 2))
        val (repo, arrivals) = repository()

        repo.start()
        runCurrent()

        assertEquals(listOf("b", "c", "a"), repo.state.value.items.map { it.id })
        assertTrue(repo.state.value.loaded)
        assertTrue("what was already waiting isn't news", arrivals.isEmpty())
    }

    @Test
    fun `stream frames add, update and remove items and announce only new ones`() = runTest {
        api.pending += item("a", 1)
        val (repo, arrivals) = repository()
        repo.start()
        runCurrent()

        api.stream.send(item("b", 2))
        api.stream.send(item("a", 1).copy(title = "Edited"))
        runCurrent()
        assertEquals(listOf("b", "a"), repo.state.value.items.map { it.id })
        assertEquals("Edited", repo.state.value.items.last().title)
        assertEquals(listOf("b"), arrivals.map { it.key })

        api.stream.send(item("b", 2, status = "resolved"))
        runCurrent()
        assertEquals(listOf("a"), repo.state.value.items.map { it.id })
    }

    @Test
    fun `a dropped stream reloads, and items that appeared meanwhile are announced`() = runTest {
        val (repo, arrivals) = repository()
        repo.start()
        runCurrent()

        api.pending += item("missed", 5)
        api.stream.close(java.io.IOException("connection reset"))
        api.stream = Channel(Channel.UNLIMITED)
        runCurrent()
        assertTrue(repo.state.value.error!!.contains("connection reset"))

        // advanceUntilIdle doesn't wait on backgroundScope, so step past the reconnect delay.
        advanceTimeBy(2_001)
        runCurrent()
        assertEquals(listOf("missed"), repo.state.value.items.map { it.id })
        assertEquals(listOf("missed"), arrivals.map { it.key })
    }

    @Test
    fun `approval events reload server approvals and announce new ones`() = runTest {
        val (repo, arrivals) = repository()
        repo.start()
        runCurrent()
        assertEquals(1, api.approvalLoads)

        api.pendingApprovals += approval("ap1")
        events.send(event("approval.requested"))
        runCurrent()
        assertEquals(listOf("ap1"), repo.state.value.approvals.map { it.id })
        assertEquals(listOf("approval:ap1"), arrivals.map { it.key })

        api.pendingApprovals.clear()
        events.send(event("approval.answered", seq = 2))
        runCurrent()
        assertTrue(repo.state.value.approvals.isEmpty())
    }

    @Test
    fun `a sidecar restart reloads attention, and lagged reloads both`() = runTest {
        val (repo, _) = repository()
        repo.start()
        runCurrent()
        val attentionBefore = api.attentionLoads
        val approvalsBefore = api.approvalLoads

        events.send(event("sidecar.started"))
        runCurrent()
        assertEquals(attentionBefore + 1, api.attentionLoads)
        assertEquals(approvalsBefore, api.approvalLoads)

        events.send(EventsSignal.Lagged)
        runCurrent()
        assertEquals(attentionBefore + 2, api.attentionLoads)
        assertEquals(approvalsBefore + 1, api.approvalLoads)
    }

    @Test
    fun `4401 on the events socket signs out`() = runTest {
        val (repo, _) = repository()
        repo.start()
        runCurrent()

        events.send(EventsSignal.SignedOut)
        runCurrent()

        assertEquals(1, signedOut)
    }

    @Test
    fun `a 401 loading attention signs out and stops retrying`() = runTest {
        api.pendingError = UnauthorizedException("sign in first")
        val (repo, _) = repository()
        repo.start()
        advanceTimeBy(10_000)
        runCurrent()

        assertEquals(1, signedOut)
        assertEquals(1, api.attentionLoads)
    }

    @Test
    fun `stop ends both streams`() = runTest {
        val (repo, _) = repository()
        repo.start()
        runCurrent()

        repo.stop()
        runCurrent()

        assertTrue(!repo.running)
    }
}

package dev.yarvis.android.ui.terminal

import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.yarvis.android.MainDispatcherRule
import dev.yarvis.android.api.PtyUpdate
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.IOException

private const val GRACE = 60_000L

class TerminalViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    private val api = FakePtyApi()
    private val store = ViewModelStore()

    private fun viewModel(id: String = "tab:terminal/t1/p1", cwd: String? = "/work"): TerminalViewModel =
        ViewModelProvider.create(
            store,
            viewModelFactory { initializer { TerminalViewModel(api, id, cwd, backgroundGraceMs = GRACE) } },
        )[id, TerminalViewModel::class]

    @Test
    fun `attaches with the page's first viewport, then only resizes`() = runTest {
        val vm = viewModel()
        assertTrue(api.connections.isEmpty())

        vm.onViewport(100, 30)
        vm.onViewport(90, 40)

        val conn = api.connections.single()
        assertEquals(listOf(100, 30, "/work", null), listOf(conn.cols, conn.rows, conn.cwd, conn.startOffset))
        assertTrue(conn.started)
        assertEquals(listOf(90 to 40), conn.resizes)
        // A shell is attached without a check: attaching is how a new one starts.
        assertTrue(api.existsAsked.isEmpty())
    }

    @Test
    fun `moves through connecting, live, reconnecting and exited`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        assertEquals(TerminalStatus.Connecting, vm.state.value.status)

        api.last.emit(PtyUpdate.Output("hi".toByteArray()))
        assertEquals(TerminalStatus.Live, vm.state.value.status)

        api.last.emit(PtyUpdate.Reconnecting)
        assertEquals(TerminalStatus.Reconnecting, vm.state.value.status)

        api.last.emit(PtyUpdate.Exit(3))
        api.last.end()
        assertEquals(TerminalStatus.Exited(3), vm.state.value.status)
        assertTrue(vm.state.value.canStartNewShell)
    }

    @Test
    fun `a refusal shows the server's error message`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        api.last.emit(PtyUpdate.Error("session cap reached"))
        api.last.emit(PtyUpdate.Refused(4400))
        api.last.end()

        assertEquals(TerminalStatus.Failed("session cap reached"), vm.state.value.status)
    }

    @Test
    fun `a connection that ends without saying why is a failure`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        api.last.end()

        assertTrue(vm.state.value.status is TerminalStatus.Failed)
    }

    @Test
    fun `sign-out is reported`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        api.last.emit(PtyUpdate.SignedOut)
        api.last.end()

        assertEquals(TerminalStatus.SignedOut, vm.state.value.status)
    }

    @Test
    fun `an agent session reconnects only while it still exists`() = runTest {
        val vm = viewModel(id = "ws-claude:w1")
        vm.onViewport(80, 24)
        val mayReconnect = api.last.mayReconnect!!

        api.exists = false
        assertFalse(mayReconnect())
        assertEquals(listOf("ws-claude:w1", "ws-claude:w1"), api.existsAsked)
        api.last.emit(PtyUpdate.Exit(0))
        api.last.end()
        assertFalse(vm.state.value.canStartNewShell)
    }

    @Test
    fun `a dead agent session is never attached, since that would spawn a shell`() = runTest {
        api.exists = false
        val vm = viewModel(id = "review-claude:w1")
        vm.onViewport(80, 24)

        assertTrue(api.connections.isEmpty())
        assertTrue(vm.state.value.status is TerminalStatus.Failed)
    }

    @Test
    fun `a new page gets the screen replayed, and a reset clears it`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        api.last.emit(PtyUpdate.Output("one ".toByteArray()))
        api.last.emit(PtyUpdate.Output("two".toByteArray()))

        val first = RecordingSink()
        vm.attachSink(first)
        assertEquals(listOf("reset", "one two"), first.calls)

        api.last.emit(PtyUpdate.Reset)
        api.last.emit(PtyUpdate.Output("fresh".toByteArray()))
        assertEquals(listOf("reset", "one two", "reset", "fresh"), first.calls)

        vm.detachSink(first)
        val second = RecordingSink()
        vm.attachSink(second)
        assertEquals(listOf("reset", "fresh"), second.calls)
    }

    @Test
    fun `Ctrl applies to the next key only, and input never takes the size`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)

        vm.onInput("l")
        vm.toggleCtrl()
        assertTrue(vm.state.value.ctrlArmed)
        vm.onInput("c")
        vm.onInput("c")

        assertEquals(listOf("l", "\u0003", "c"), api.last.sent)
        assertEquals(0, api.last.focusCount)
        assertFalse(vm.state.value.ctrlArmed)
    }

    @Test
    fun `the terminal's own replies don't use up an armed Ctrl`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        vm.toggleCtrl()

        vm.onInput("\u001b[?1;2c")
        vm.onInput("d")

        assertEquals(listOf("\u001b[?1;2c", "\u0004"), api.last.sent)
        assertEquals(0, api.last.focusCount)
    }

    @Test
    fun `opening takes the size, and a reconnect takes it back only on screen`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        api.last.emit(PtyUpdate.Output("a".toByteArray()))
        assertEquals(1, api.last.focusCount)

        api.last.emit(PtyUpdate.Reconnecting)
        api.last.emit(PtyUpdate.Output("b".toByteArray()))
        assertEquals(2, api.last.focusCount)

        vm.onAppStopped()
        api.last.emit(PtyUpdate.Reconnecting)
        api.last.emit(PtyUpdate.Output("c".toByteArray()))
        assertEquals(2, api.last.focusCount)
    }

    @Test
    fun `a dropped shell is checked before it reconnects, and shows as exited when gone`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        api.exists = false
        assertFalse(api.last.mayReconnect!!())
        api.last.emit(PtyUpdate.Refused(1000))
        api.last.end()

        assertEquals(TerminalStatus.Exited(null), vm.state.value.status)
        assertTrue(vm.state.value.canStartNewShell)
    }

    @Test
    fun `a tap always takes the size over`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        vm.onTap()
        vm.onTap()

        assertEquals(2, api.last.focusCount)
    }

    @Test
    fun `arrows follow the page's cursor mode`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        vm.press(ExtraKey.Up)
        vm.onModes(appCursor = true)
        vm.press(ExtraKey.Up)
        vm.press(ExtraKey.ShiftTab)

        assertEquals(listOf("\u001b[A", "\u001bOA", "\u001b[Z"), api.last.sent)
    }

    @Test
    fun `starting a new shell reattaches with a clear screen`() = runTest {
        val vm = viewModel()
        val sink = RecordingSink()
        vm.attachSink(sink)
        vm.onViewport(80, 24)
        api.last.emit(PtyUpdate.Output("old".toByteArray()))
        api.last.emit(PtyUpdate.Exit(1))
        api.last.end()

        vm.startNewShell()

        assertEquals(2, api.connections.size)
        assertTrue(api.connections.first().closed)
        assertEquals(TerminalStatus.Connecting, vm.state.value.status)
        assertEquals("reset", sink.calls.last())
    }

    @Test
    fun `starting a new shell does nothing for an agent or a live shell`() = runTest {
        val live = viewModel()
        live.onViewport(80, 24)
        live.startNewShell()
        assertEquals(1, api.connections.size)

        val agent = viewModel(id = "ws-claude:w1")
        agent.onViewport(80, 24)
        api.last.emit(PtyUpdate.Exit(0))
        api.last.end()
        agent.startNewShell()
        assertEquals(2, api.connections.size)
    }

    @Test
    fun `an agent whose check fails is never attached`() = runTest {
        api.existsError = IOException("offline")
        val vm = viewModel(id = "ws-claude:w1")
        vm.onViewport(80, 24)

        assertTrue(api.connections.isEmpty())
        assertTrue(vm.state.value.status is TerminalStatus.Failed)
    }

    @Test
    fun `a failure waits for Retry instead of reconnecting on every resize`() = runTest {
        api.existsError = IOException("offline")
        val vm = viewModel(id = "ws-claude:w1")
        vm.onViewport(80, 24)
        vm.onViewport(81, 24)
        assertEquals(1, api.existsAsked.size)

        api.existsError = null
        vm.retry()
        assertEquals(1, api.connections.size)
    }

    @Test
    fun `refusals explain themselves`() = runTest {
        val denied = viewModel()
        denied.onViewport(80, 24)
        api.last.emit(PtyUpdate.Refused(4403))
        api.last.end()
        assertEquals(TerminalStatus.Failed("This device isn't allowed to use terminals."), denied.state.value.status)

        val agent = viewModel(id = "ws-claude:w2")
        agent.onViewport(80, 24)
        api.last.emit(PtyUpdate.Refused(1000))
        api.last.end()
        assertEquals(TerminalStatus.Failed("This session is no longer running."), agent.state.value.status)
    }

    @Test
    fun `the socket closes after the background grace and reattaches on return`() = runTest {
        val vm = viewModel()
        val sink = RecordingSink()
        vm.attachSink(sink)
        vm.onViewport(80, 24)
        api.last.emit(PtyUpdate.Output("kept".toByteArray()))
        api.last.offset = 4

        vm.onAppStopped()
        advanceTimeBy(GRACE - 1)
        assertFalse(api.last.closed)
        advanceTimeBy(2)
        assertTrue(api.last.closed)

        vm.onAppStarted()
        assertEquals(listOf("tab:terminal/t1/p1"), api.existsAsked)
        assertEquals(2, api.connections.size)
        assertEquals(4L, api.last.startOffset)
        assertEquals(listOf("reset", "kept"), sink.calls)
    }

    @Test
    fun `a shell that ended in the background shows as exited instead of respawning`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        vm.onAppStopped()
        advanceTimeBy(GRACE + 1)

        api.exists = false
        vm.onAppStarted()

        assertEquals(1, api.connections.size)
        assertEquals(TerminalStatus.Exited(null), vm.state.value.status)
    }

    @Test
    fun `a quick trip to the background keeps the socket`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        vm.onAppStopped()
        advanceTimeBy(GRACE / 2)
        vm.onAppStarted()
        advanceTimeBy(GRACE)

        assertFalse(api.last.closed)
        assertEquals(1, api.connections.size)
    }

    @Test
    fun `font size stays in range`() = runTest {
        val vm = viewModel()
        repeat(40) { vm.changeFontSize(1) }
        assertEquals(MAX_FONT_SIZE, vm.state.value.fontSize)
        repeat(40) { vm.changeFontSize(-1) }
        assertEquals(MIN_FONT_SIZE, vm.state.value.fontSize)
    }

    @Test
    fun `clearing the view model closes the connection`() = runTest {
        val vm = viewModel()
        vm.onViewport(80, 24)
        store.clear()

        assertTrue(api.last.closed)
    }
}

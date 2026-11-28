package dev.yarvis.android.ui.terminal

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalHelpersTest {
    @Test
    fun `keys encode as xterm sends them`() {
        assertEquals("\u001b", TerminalKeys.encode(ExtraKey.Esc, ctrl = false, appCursor = false))
        assertEquals("\u001b[Z", TerminalKeys.encode(ExtraKey.ShiftTab, ctrl = false, appCursor = false))
        assertEquals("\u001b[D", TerminalKeys.encode(ExtraKey.Left, ctrl = false, appCursor = false))
        assertEquals("\u001bOD", TerminalKeys.encode(ExtraKey.Left, ctrl = false, appCursor = true))
        assertEquals("\u001b[1;5D", TerminalKeys.encode(ExtraKey.Left, ctrl = true, appCursor = true))
        assertEquals("\u001c", TerminalKeys.encode(ExtraKey.Pipe, ctrl = true, appCursor = false))
        assertEquals("|", TerminalKeys.encode(ExtraKey.Pipe, ctrl = false, appCursor = false))
    }

    @Test
    fun `ctrl applies to the first character only`() {
        assertEquals("\u0003", TerminalKeys.withCtrl("c"))
        assertEquals("\u0003", TerminalKeys.withCtrl("C"))
        assertEquals("\u0001bc", TerminalKeys.withCtrl("abc"))
        assertEquals("\u001b", TerminalKeys.withCtrl("["))
        assertEquals("é", TerminalKeys.withCtrl("é"))
        assertEquals("", TerminalKeys.withCtrl(""))
    }

    @Test
    fun `the replay buffer keeps only the newest bytes`() {
        val buffer = ReplayBuffer(capacity = 8)
        buffer.append("abcde".toByteArray())
        buffer.append("fghij".toByteArray())
        assertEquals("cdefghij", String(buffer.snapshot()))
        assertEquals(8, buffer.size)

        buffer.append("0123456789".toByteArray())
        assertEquals("23456789", String(buffer.snapshot()))

        buffer.clear()
        assertEquals(0, buffer.snapshot().size)
    }

    @Test
    fun `the replay buffer is capped at the server's scrollback`() {
        val buffer = ReplayBuffer()
        repeat(3) { buffer.append(ByteArray(600 * 1024)) }
        assertEquals(REPLAY_CAPACITY, buffer.size)
    }

    @Test
    fun `the batcher coalesces writes and splits big ones`() {
        val batcher = OutputBatcher(maxBatchBytes = 4)
        batcher.write("ab".toByteArray())
        batcher.write("cdef".toByteArray())

        val batches = batcher.drain()
        assertEquals(listOf("abcd", "ef"), batches.map { String((it as OutputBatch.Bytes).bytes) })
        assertTrue(batcher.isEmpty)
    }

    @Test
    fun `a reset drops output written before it`() {
        val batcher = OutputBatcher()
        batcher.write("stale".toByteArray())
        batcher.reset()
        batcher.write("new".toByteArray())

        val batches = batcher.drain()
        assertEquals(OutputBatch.Reset, batches[0])
        assertArrayEquals("new".toByteArray(), (batches[1] as OutputBatch.Bytes).bytes)
        assertEquals(2, batches.size)
    }
}

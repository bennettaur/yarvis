package dev.yarvis.android.ui.terminal

/** Where a terminal's output goes: the page that draws it. */
interface TerminalSink {
    fun reset()
    fun write(bytes: ByteArray)
}

/** The server keeps 1 MiB of scrollback per session, so a replay never needs more. */
const val REPLAY_CAPACITY = 1 shl 20

/**
 * The most recent [capacity] bytes of a session's output, so a new page (after
 * a rotation, or a WebView crash) can be brought back to the same screen.
 * Trimming can cut an escape sequence in half; the server's own snapshot has the
 * same edge, and the next redraw fixes it.
 */
class ReplayBuffer(private val capacity: Int = REPLAY_CAPACITY) {
    private val chunks = ArrayDeque<ByteArray>()

    var size: Int = 0
        private set

    fun append(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        if (bytes.size >= capacity) {
            clear()
            chunks.addLast(bytes.copyOfRange(bytes.size - capacity, bytes.size))
            size = capacity
            return
        }
        chunks.addLast(bytes)
        size += bytes.size
        while (size > capacity) {
            val first = chunks.removeFirst()
            val excess = size - capacity
            if (first.size > excess) {
                chunks.addFirst(first.copyOfRange(excess, first.size))
                size -= excess
            } else {
                size -= first.size
            }
        }
    }

    fun clear() {
        chunks.clear()
        size = 0
    }

    fun snapshot(): ByteArray {
        val out = ByteArray(size)
        var at = 0
        for (chunk in chunks) {
            chunk.copyInto(out, at)
            at += chunk.size
        }
        return out
    }
}

/** One call into the page. */
sealed interface OutputBatch {
    data object Reset : OutputBatch

    class Bytes(val bytes: ByteArray) : OutputBatch
}

/**
 * Coalesces output between flushes, so a big catch-up is a few page calls
 * rather than one per socket frame. Each call is capped at [maxBatchBytes] so no
 * single base64 string handed to the page gets huge. Not thread-safe: the page
 * side uses it from the main thread only.
 */
class OutputBatcher(private val maxBatchBytes: Int = 256 * 1024) {
    private var resetPending = false
    private val pending = ReplayBuffer(Int.MAX_VALUE)

    val isEmpty: Boolean get() = !resetPending && pending.size == 0

    fun write(bytes: ByteArray) = pending.append(bytes)

    /** Output written before a reset would be cleared straight away, so it is dropped. */
    fun reset() {
        pending.clear()
        resetPending = true
    }

    fun drain(): List<OutputBatch> {
        val out = mutableListOf<OutputBatch>()
        if (resetPending) out += OutputBatch.Reset
        val bytes = pending.snapshot()
        var at = 0
        while (at < bytes.size) {
            val end = minOf(bytes.size, at + maxBatchBytes)
            out += OutputBatch.Bytes(bytes.copyOfRange(at, end))
            at = end
        }
        resetPending = false
        pending.clear()
        return out
    }
}

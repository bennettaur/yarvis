package dev.yarvis.android.data

import dev.yarvis.android.api.ChatApi
import dev.yarvis.android.api.ChatEvent
import dev.yarvis.android.api.ChatRequest
import dev.yarvis.android.api.ToolActivity
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlin.time.TimeMark
import kotlin.time.TimeSource

/** A tool call waiting for the user's yes or no, from a `tool_approval_request` event. */
data class PendingApproval(
    val id: String,
    val name: String,
    val server: String,
    val args: JsonElement?,
    val reason: String?,
)

/**
 * Runs chat turns in the signed-in session's scope rather than a screen's.
 * Dropping a turn's stream is how the sidecar hears Stop, so a turn tied to the
 * thread's view model would be stopped by pressing Back. Here it runs until it
 * ends, [stop] is called, or the user signs out ([stopAll]).
 *
 * A turn is found by its thread's key: the chat session id, or the "new chat"
 * key the thread was opened with until the turn creates the session. Both keys
 * then find it, so the list can open a new chat's thread by its session id.
 * A finished or stopped turn is dropped, since the sidecar has saved the reply;
 * a failed one stays, so its thread can show the failure and offer a retry.
 */
class ChatTurns(
    private val api: ChatApi,
    private val scope: CoroutineScope,
    private val clock: TimeSource = TimeSource.Monotonic,
) {
    data class Turn(
        val id: Long,
        val keys: Set<String>,
        val sessionId: String?,
        /** The user's message, kept so a failed turn can be sent again. */
        val text: String,
        val started: TimeMark,
        /** The reply so far. */
        val reply: String = "",
        val activity: List<ToolActivity> = emptyList(),
        /** When the tool call still pending at the end of [activity] started. */
        val toolStarted: TimeMark? = null,
        /** Oldest first; the approval bar answers the front one. */
        val approvals: List<PendingApproval> = emptyList(),
        /** Why the turn failed, or null while it runs. */
        val failure: String? = null,
    ) {
        val running: Boolean get() = failure == null

        /** The tool the turn is waiting on, if any. */
        val runningTool: ToolActivity? get() = activity.lastOrNull()?.takeIf { it.status == "pending" }
    }

    private val turns = MutableStateFlow<List<Turn>>(emptyList())
    private val jobs = mutableMapOf<Long, Job>()
    private var nextId = 0L

    /** The running or failed turn for a thread, or null when there is none. */
    fun turn(key: String): Flow<Turn?> = turns.map { all -> all.find(key) }.distinctUntilChanged()

    /** The sessions with a turn running, for the chat list's "Replying…" marker. */
    val replying: Flow<Set<String>> =
        turns.map { all -> all.filter { it.running }.mapNotNullTo(mutableSetOf()) { it.sessionId } }.distinctUntilChanged()

    /**
     * Starts a turn on the thread [key]; a null [sessionId] creates the session
     * first. Returns false without sending while the thread already has a turn running.
     */
    fun send(key: String, sessionId: String?, text: String, provider: String, model: String): Boolean {
        val id = nextId++
        var claimed = false
        turns.update { all ->
            claimed = all.find(key)?.running != true
            if (!claimed) return@update all
            // A failed turn on this thread is replaced by the new one.
            all.filterNot { key in it.keys } + Turn(id, setOfNotNull(key, sessionId), sessionId, text, clock.markNow())
        }
        if (!claimed) return false
        // Lazy, so the job is in [jobs] before it can finish and remove itself.
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val session = sessionId ?: api.createSession().id.also { created ->
                    update(id) { it.copy(sessionId = created, keys = it.keys + created) }
                }
                // The sidecar saves no reply for a turn that ended in an error, so the turn fails.
                var failure: String? = null
                api.streamChat(ChatRequest(session, text, provider, model)).collect { event ->
                    if (event.type == "error") failure = listOfNotNull(event.message, event.detail).joinToString("\n\n")
                    update(id) { it.apply(event) }
                }
                val failed = failure
                if (failed == null) remove(id) else fail(id, failed)
            } catch (e: CancellationException) {
                remove(id)
                throw e
            } catch (e: Exception) {
                fail(id, "The turn failed: ${e.message}")
            } finally {
                jobs.remove(id)
            }
        }
        jobs[id] = job
        job.start()
        return true
    }

    /**
     * Stops the thread's running turn by dropping its stream, which the sidecar
     * takes as the user's stop. Returns false when nothing was running.
     */
    fun stop(key: String): Boolean {
        val turn = turns.value.find(key)?.takeIf { it.running } ?: return false
        jobs.remove(turn.id)?.cancel()
        remove(turn.id)
        return true
    }

    /** Ends every turn, on sign-out: the next session must not see them. */
    fun stopAll() {
        jobs.values.forEach { it.cancel() }
        jobs.clear()
        turns.value = emptyList()
    }

    fun dropApproval(key: String, approvalId: String) {
        val turn = turns.value.find(key) ?: return
        update(turn.id) { t -> t.copy(approvals = t.approvals.filterNot { it.id == approvalId }) }
    }

    fun dismissFailure(key: String) = turns.update { all -> all.filterNot { key in it.keys && !it.running } }

    private fun List<Turn>.find(key: String) = firstOrNull { key in it.keys }

    private fun update(id: Long, change: (Turn) -> Turn) =
        turns.update { all -> all.map { if (it.id == id) change(it) else it } }

    private fun remove(id: Long) = turns.update { all -> all.filterNot { it.id == id } }

    // Approvals the turn didn't get answered can't be answered after it.
    private fun fail(id: Long, message: String) = update(id) { it.copy(failure = message, approvals = emptyList()) }

    private fun Turn.apply(event: ChatEvent): Turn = when (event.type) {
        "delta" -> copy(reply = reply + event.text.orEmpty())
        "tool_call" -> {
            val callId = event.id
            if (callId == null) {
                this
            } else {
                copy(
                    activity = activity + ToolActivity(callId, event.name ?: callId, event.server, event.args, "pending"),
                    toolStarted = clock.markNow(),
                )
            }
        }
        "tool_result" -> copy(
            activity = activity.map {
                if (it.id != event.id) it else it.copy(status = event.status ?: "ok", result = event.result, durationMs = event.durationMs)
            },
        )
        "tool_approval_request" -> {
            val callId = event.id
            if (callId == null || approvals.any { it.id == callId }) {
                this
            } else {
                copy(approvals = approvals + PendingApproval(callId, event.name ?: callId, event.server.orEmpty(), event.args, event.reason))
            }
        }
        else -> this
    }
}

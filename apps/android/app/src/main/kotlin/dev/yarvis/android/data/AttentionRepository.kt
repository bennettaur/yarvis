package dev.yarvis.android.data

import dev.yarvis.android.api.AttentionApi
import dev.yarvis.android.api.AttentionItem
import dev.yarvis.android.api.EventsSignal
import dev.yarvis.android.api.ServerApproval
import dev.yarvis.android.api.UnauthorizedException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

data class AttentionState(
    /** Pending sidecar items, newest first. */
    val items: List<AttentionItem> = emptyList(),
    /** Pending server approvals, oldest first. */
    val approvals: List<ServerApproval> = emptyList(),
    val loaded: Boolean = false,
    val error: String? = null,
)

/** Something new that wants the user, for a notification. */
data class Arrival(val key: String, val title: String, val body: String?)

/**
 * The attention stream the app shows and notifies about, kept live from two
 * sources:
 * - The sidecar's `/api/attention/stream` SSE carries the bell's items
 *   (permission prompts, questions, assistant and system items). It is
 *   forward-only, so every (re)connect reloads the pending list first.
 * - The server's `/api/events` socket carries `approval.*` for server
 *   approvals, and `sidecar.started`, after which the sidecar's data is reloaded.
 */
class AttentionRepository(
    private val api: AttentionApi,
    private val events: () -> Flow<EventsSignal>,
    private val scope: CoroutineScope,
    private val onSignedOut: () -> Unit,
    private val reconnectMs: Long = 2_000,
) {
    private val _state = MutableStateFlow(AttentionState())
    val state: StateFlow<AttentionState> = _state.asStateFlow()

    private val _arrivals = MutableSharedFlow<Arrival>(extraBufferCapacity = 32, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val arrivals: SharedFlow<Arrival> = _arrivals

    private var jobs: List<Job> = emptyList()

    /** Ids already seen, so a reload after a reconnect only announces what's really new. */
    private val seen = mutableSetOf<String>()
    private var hydrated = false

    val running: Boolean get() = jobs.any { it.isActive }

    fun start() {
        if (running) return
        jobs = listOf(scope.launch { attentionLoop() }, scope.launch { eventsLoop() })
    }

    fun stop() {
        jobs.forEach { it.cancel() }
        jobs = emptyList()
    }

    /** Drops an item the user just answered, ahead of the stream saying so. */
    fun forgetItem(id: String) = _state.update { s -> s.copy(items = s.items.filterNot { it.id == id }) }

    fun forgetApproval(id: String) = _state.update { s -> s.copy(approvals = s.approvals.filterNot { it.id == id }) }

    suspend fun reloadAttention() {
        val items = api.pendingAttention().sortedByDescending { it.seq }
        val announce = hydrated
        hydrated = true
        _state.update { it.copy(items = items, loaded = true, error = null) }
        for (item in items) noteArrival(item, announce)
    }

    suspend fun reloadApprovals() {
        val approvals = api.approvals()
        _state.update { it.copy(approvals = approvals) }
        for (approval in approvals) {
            if (seen.add("approval:${approval.id}")) {
                _arrivals.emit(Arrival("approval:${approval.id}", "Approval needed", approval.summary))
            }
        }
    }

    private suspend fun noteArrival(item: AttentionItem, announce: Boolean) {
        if (seen.add(item.id) && announce) _arrivals.emit(Arrival(item.id, item.title, item.body))
    }

    private fun apply(item: AttentionItem) {
        _state.update { s ->
            val rest = s.items.filterNot { it.id == item.id }
            val items = if (item.status == "pending") (rest + item).sortedByDescending { it.seq } else rest
            s.copy(items = items)
        }
    }

    private suspend fun attentionLoop() {
        while (scope.isActive) {
            try {
                reloadAttention()
                api.attentionStream().collect { item ->
                    if (item.status == "pending") noteArrival(item, announce = true)
                    apply(item)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: UnauthorizedException) {
                onSignedOut()
                return
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Couldn't reach the server") }
            }
            delay(reconnectMs)
        }
    }

    private suspend fun eventsLoop() {
        safely { reloadApprovals() }
        events().collect { signal ->
            when (signal) {
                is EventsSignal.Event -> when (signal.event.kind) {
                    "approval.requested", "approval.answered" -> safely { reloadApprovals() }
                    "sidecar.started" -> safely { reloadAttention() }
                }
                EventsSignal.Lagged -> {
                    safely { reloadApprovals() }
                    safely { reloadAttention() }
                }
                EventsSignal.SignedOut -> onSignedOut()
                is EventsSignal.Refused -> Unit
            }
        }
    }

    private suspend fun safely(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (_: UnauthorizedException) {
            onSignedOut()
        } catch (e: Exception) {
            _state.update { it.copy(error = e.message ?: "Couldn't reach the server") }
        }
    }
}

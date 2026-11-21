package dev.yarvis.android.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.yarvis.android.api.ChatApi
import dev.yarvis.android.api.ChatEvent
import dev.yarvis.android.api.ChatMessage
import dev.yarvis.android.api.ChatRequest
import dev.yarvis.android.api.ProviderInfo
import dev.yarvis.android.api.ReauthCancelledException
import dev.yarvis.android.api.ToolActivity
import dev.yarvis.android.data.ChatModelPrefs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

/** A tool call waiting for the user's yes or no, from a `tool_approval_request` event. */
data class PendingApproval(
    val id: String,
    val name: String,
    val server: String,
    val args: JsonElement?,
    val reason: String?,
)

data class ThreadMessage(val role: String, val content: String, val toolCalls: List<ToolActivity> = emptyList())

data class ThreadState(
    val sessionId: String? = null,
    val messages: List<ThreadMessage> = emptyList(),
    val loading: Boolean = false,
    /** The reply so far, while a turn runs. */
    val streaming: String? = null,
    val activity: List<ToolActivity> = emptyList(),
    /** Oldest first; the approval bar answers the front one. */
    val approvals: List<PendingApproval> = emptyList(),
    val providers: List<ProviderInfo> = emptyList(),
    val provider: String = "",
    val model: String = "",
    val error: String? = null,
    /** Something the user did, such as stopping a turn. Shown without alarm. */
    val notice: String? = null,
) {
    val running: Boolean get() = streaming != null
}

/**
 * One chat thread: its history, a running turn's streamed reply and tool
 * activity, and the tool approvals the turn waits on. [sessionId] is null for
 * a thread that starts with the first message.
 */
class ChatThreadViewModel(
    private val api: ChatApi,
    private val prefs: ChatModelPrefs,
    sessionId: String?,
) : ViewModel() {
    private val _state = MutableStateFlow(ThreadState(sessionId = sessionId, loading = sessionId != null))
    val state: StateFlow<ThreadState> = _state.asStateFlow()

    private var turn: Job? = null

    init {
        viewModelScope.launch { loadProviders() }
        if (sessionId != null) viewModelScope.launch { loadMessages(sessionId) }
    }

    private suspend fun loadProviders() {
        try {
            val providers = api.providers()
            val saved = prefs.load()
            val chosen = providers.firstOrNull { it.id == saved?.provider }
                ?: providers.firstOrNull { it.available }
                ?: providers.firstOrNull()
            val model = chosen?.models?.firstOrNull { it.id == saved?.model }?.id ?: chosen?.models?.firstOrNull()?.id
            _state.update { it.copy(providers = providers, provider = chosen?.id.orEmpty(), model = model.orEmpty()) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(error = "Couldn't load models: ${e.message}") }
        }
    }

    private suspend fun loadMessages(sessionId: String) {
        try {
            val messages = api.messages(sessionId).map { it.toThreadMessage() }
            _state.update { it.copy(messages = messages, loading = false) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(loading = false, error = "Couldn't load the chat: ${e.message}") }
        }
    }

    fun chooseModel(provider: String, model: String) {
        _state.update { it.copy(provider = provider, model = model) }
        viewModelScope.launch { prefs.save(provider, model) }
    }

    fun dismissMessage() = _state.update { it.copy(error = null, notice = null) }

    fun send(text: String) {
        val message = text.trim()
        val before = _state.value
        if (message.isEmpty() || before.running) return
        if (before.provider.isEmpty() || before.model.isEmpty()) {
            _state.update { it.copy(error = "No chat model is set up on the server.") }
            return
        }
        _state.update {
            it.copy(
                messages = it.messages + ThreadMessage("user", message),
                streaming = "",
                activity = emptyList(),
                error = null,
                notice = null,
            )
        }
        turn = viewModelScope.launch {
            try {
                val sessionId = before.sessionId ?: api.createSession().id.also { id -> _state.update { it.copy(sessionId = id) } }
                // The sidecar saves no reply for a turn that ended in an error, so neither do we.
                var failed = false
                api.streamChat(ChatRequest(sessionId, message, before.provider, before.model)).collect { event ->
                    if (event.type == "error") failed = true
                    applyEvent(event)
                }
                finishTurn(saveReply = !failed)
                loadMessages(sessionId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(error = "The turn failed: ${e.message}") }
                finishTurn(saveReply = false)
            }
        }
    }

    /**
     * Stops the running turn by dropping its stream, which the sidecar takes as
     * the user's stop. It saves nothing for the turn, so the partial reply goes too.
     */
    fun stop() {
        val job = turn ?: return
        if (!job.isActive) return
        job.cancel()
        finishTurn(saveReply = false)
        _state.update { it.copy(notice = "Turn stopped. Nothing was saved for it.") }
    }

    fun answerApproval(approval: PendingApproval, approved: Boolean) {
        viewModelScope.launch {
            try {
                api.answerToolApproval(approval.id, approved)
                _state.update { s -> s.copy(approvals = s.approvals.filterNot { it.id == approval.id }) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: ReauthCancelledException) {
                // The approval stays in the bar for another try.
            } catch (e: Exception) {
                _state.update { it.copy(error = "Couldn't send the answer: ${e.message}") }
            }
        }
    }

    private fun applyEvent(event: ChatEvent) {
        _state.update { s ->
            when (event.type) {
                "delta" -> s.copy(streaming = (s.streaming ?: "") + event.text.orEmpty())
                "tool_call" -> {
                    val id = event.id ?: return@update s
                    s.copy(
                        activity = s.activity + ToolActivity(id, event.name ?: id, event.server, event.args, "pending"),
                    )
                }
                "tool_result" -> s.copy(
                    activity = s.activity.map {
                        if (it.id != event.id) {
                            it
                        } else {
                            it.copy(status = event.status ?: "ok", result = event.result, durationMs = event.durationMs)
                        }
                    },
                )
                "tool_approval_request" -> {
                    val id = event.id ?: return@update s
                    if (s.approvals.any { it.id == id }) return@update s
                    s.copy(approvals = s.approvals + PendingApproval(id, event.name ?: id, event.server.orEmpty(), event.args, event.reason))
                }
                "error" -> s.copy(error = listOfNotNull(event.message, event.detail).joinToString("\n\n"))
                else -> s
            }
        }
    }

    private fun finishTurn(saveReply: Boolean) {
        _state.update { s ->
            val reply = s.streaming
            val messages = if (saveReply && (!reply.isNullOrEmpty() || s.activity.isNotEmpty())) {
                s.messages + ThreadMessage("assistant", reply.orEmpty(), s.activity)
            } else {
                s.messages
            }
            // Approvals the turn didn't get answered can't be answered after it.
            s.copy(messages = messages, streaming = null, activity = emptyList(), approvals = emptyList())
        }
    }
}

private fun ChatMessage.toThreadMessage() = ThreadMessage(role, content, toolCalls.orEmpty())

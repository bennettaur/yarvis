package dev.yarvis.android.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.yarvis.android.api.ChatApi
import dev.yarvis.android.api.ChatMessage
import dev.yarvis.android.api.ProviderInfo
import dev.yarvis.android.api.ReauthCancelledException
import dev.yarvis.android.api.ToolActivity
import dev.yarvis.android.data.ChatModelPrefs
import dev.yarvis.android.data.ChatTurns
import dev.yarvis.android.data.PendingApproval
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

data class ThreadMessage(val role: String, val content: String, val toolCalls: List<ToolActivity> = emptyList())

data class ThreadState(
    val sessionId: String? = null,
    val messages: List<ThreadMessage> = emptyList(),
    val loading: Boolean = false,
    /** The thread's turn: running, or failed and waiting for a retry. */
    val turn: ChatTurns.Turn? = null,
    val providers: List<ProviderInfo> = emptyList(),
    val provider: String = "",
    val model: String = "",
    val error: String? = null,
    /** Something the user did, such as stopping a turn. Shown without alarm. */
    val notice: String? = null,
) {
    val running: Boolean get() = turn?.running == true

    /** The reply so far, while a turn runs. */
    val streaming: String? get() = turn?.takeIf { it.running }?.reply
    val activity: List<ToolActivity> get() = turn?.takeIf { it.running }?.activity.orEmpty()
    val approvals: List<PendingApproval> get() = turn?.approvals.orEmpty()

    /** Why the last turn failed; the thread offers a retry. */
    val failure: String? get() = turn?.failure

    /**
     * The turn's message, shown until the saved thread has it. A retry is
     * collapsed onto the user row the sidecar already saved, so it isn't shown twice.
     */
    val pendingMessage: String?
        get() = turn?.text?.takeUnless(messages::endsWithUser)
}

/**
 * One chat thread: its history, plus the turn [ChatTurns] runs for it. The
 * turn outlives this view model, so leaving the thread doesn't stop it and
 * reopening the thread shows it still going. [threadKey] finds the turn: the
 * session id, or the "new chat" key for a thread that starts with the first
 * message, until that message creates the session.
 */
class ChatThreadViewModel(
    private val api: ChatApi,
    private val prefs: ChatModelPrefs,
    private val turns: ChatTurns,
    sessionId: String?,
    private val threadKey: String = sessionId ?: "new:${UUID.randomUUID()}",
) : ViewModel() {
    private val _state = MutableStateFlow(ThreadState(sessionId = sessionId, loading = sessionId != null))
    val state: StateFlow<ThreadState> = _state.asStateFlow()

    // Set by [stop], so the turn's end shows the stop notice instead of a reply.
    private var stopping = false

    init {
        viewModelScope.launch { loadProviders() }
        if (sessionId != null) viewModelScope.launch { loadMessages(sessionId) }
        viewModelScope.launch { turns.turn(threadKey).collect(::onTurn) }
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

    private fun onTurn(turn: ChatTurns.Turn?) {
        val previous = _state.value.turn
        _state.update { it.copy(turn = turn, sessionId = turn?.sessionId ?: it.sessionId) }
        if (previous?.running != true) return
        when {
            turn == null && stopping -> {
                stopping = false
                // The sidecar saves nothing for a stopped turn, so the partial reply goes too.
                keepMessage(previous, reply = false)
                _state.update { it.copy(notice = "Turn stopped. Nothing was saved for it.") }
            }
            turn == null -> {
                // Shown at once, then replaced by the saved thread.
                keepMessage(previous, reply = true)
                reload()
            }
            // The sidecar saved the user's message before the turn failed.
            !turn.running -> reload()
        }
    }

    private fun keepMessage(turn: ChatTurns.Turn, reply: Boolean) = _state.update { s ->
        val user = if (s.messages.endsWithUser(turn.text)) emptyList() else listOf(ThreadMessage("user", turn.text))
        val answer = if (reply && (turn.reply.isNotEmpty() || turn.activity.isNotEmpty())) {
            listOf(ThreadMessage("assistant", turn.reply, turn.activity))
        } else {
            emptyList()
        }
        s.copy(messages = s.messages + user + answer)
    }

    private fun reload() {
        val sessionId = _state.value.sessionId ?: return
        viewModelScope.launch { loadMessages(sessionId) }
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
        _state.update { it.copy(error = null, notice = null) }
        turns.send(threadKey, before.sessionId, message, before.provider, before.model)
    }

    /**
     * Sends a failed turn's message again. The sidecar collapses it onto the
     * user row it already saved, so the thread doesn't get the message twice.
     */
    fun retry() {
        val failed = _state.value.turn?.takeIf { !it.running } ?: return
        send(failed.text)
    }

    /** Stops the running turn. Leaving the thread doesn't; only this does. */
    fun stop() {
        stopping = true
        if (!turns.stop(threadKey)) stopping = false
    }

    fun answerApproval(approval: PendingApproval, approved: Boolean) {
        viewModelScope.launch {
            try {
                api.answerToolApproval(approval.id, approved)
                turns.dropApproval(threadKey, approval.id)
            } catch (e: CancellationException) {
                throw e
            } catch (_: ReauthCancelledException) {
                // The approval stays in the bar for another try.
            } catch (e: Exception) {
                _state.update { it.copy(error = "Couldn't send the answer: ${e.message}") }
            }
        }
    }
}

private fun List<ThreadMessage>.endsWithUser(text: String) = lastOrNull()?.let { it.role == "user" && it.content == text } == true

private fun ChatMessage.toThreadMessage() = ThreadMessage(role, content, toolCalls.orEmpty())

package dev.yarvis.android.ui.attention

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.yarvis.android.api.AgentQuestion
import dev.yarvis.android.api.ApiException
import dev.yarvis.android.api.AttentionApi
import dev.yarvis.android.api.AttentionItem
import dev.yarvis.android.api.HeadsDownAnswer
import dev.yarvis.android.api.HeadsDownQuestion
import dev.yarvis.android.api.PermissionDecision
import dev.yarvis.android.api.PermissionRequest
import dev.yarvis.android.api.QuestionAnswer
import dev.yarvis.android.api.ReauthCancelledException
import dev.yarvis.android.api.ServerApproval
import dev.yarvis.android.data.AttentionRepository
import dev.yarvis.android.data.AttentionState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** What an opened item offers, loaded when the user opens it. */
sealed interface ItemDetail {
    data object Loading : ItemDetail

    /** Claude Code permission prompts still waiting in that session. Empty when they were settled elsewhere. */
    data class Permissions(val requests: List<PermissionRequest>) : ItemDetail

    data class Questions(val questions: List<AgentQuestion>) : ItemDetail

    data class HeadsDown(val question: HeadsDownQuestion?) : ItemDetail

    /** Nothing to answer here; the user can mark it read or dismiss it. */
    data object Info : ItemDetail

    data class Failed(val message: String) : ItemDetail
}

data class OpenItem(val item: AttentionItem, val detail: ItemDetail)

/**
 * The attention list and its answers. The list itself is live in
 * [AttentionRepository]; this adds the opened item's details and the actions.
 */
class AttentionViewModel(
    private val api: AttentionApi,
    private val repository: AttentionRepository,
) : ViewModel() {
    val attention: StateFlow<AttentionState> = repository.state

    private val _open = MutableStateFlow<OpenItem?>(null)
    val open: StateFlow<OpenItem?> = _open.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message.asStateFlow()

    fun dismissMessage() {
        _message.value = null
    }

    fun refresh() {
        viewModelScope.launch {
            act("Couldn't refresh") {
                repository.reloadAttention()
                repository.reloadApprovals()
            }
        }
    }

    fun openItem(item: AttentionItem) {
        _open.value = OpenItem(item, ItemDetail.Loading)
        viewModelScope.launch {
            val detail = try {
                when {
                    item.isClaudePermission -> ItemDetail.Permissions(api.permissions(item.sessionKey!!))
                    item.kind == "question" -> ItemDetail.Questions(api.questionsFor(item))
                    item.headsDownQuestionId != null -> ItemDetail.HeadsDown(api.headsDownQuestion(item.headsDownQuestionId!!))
                    else -> ItemDetail.Info
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ItemDetail.Failed(e.message ?: "Couldn't load it")
            }
            _open.update { if (it?.item?.id == item.id) it.copy(detail = detail) else it }
        }
    }

    fun close() {
        _open.value = null
    }

    fun decidePermission(request: PermissionRequest, decision: PermissionDecision) = answer {
        val delivered = api.decidePermission(request.id, decision)
        if (!delivered) _message.value = "That prompt was already answered in the terminal."
        val item = _open.value?.item ?: return@answer
        val left = api.permissions(request.sessionKey)
        if (left.isEmpty()) {
            repository.forgetItem(item.id)
            close()
        } else {
            _open.value = OpenItem(item, ItemDetail.Permissions(left))
        }
    }

    fun answerQuestion(question: AgentQuestion, answers: List<QuestionAnswer>) = answer {
        api.answerQuestion(question.id, answers)
        afterQuestion(question)
    }

    fun declineQuestion(question: AgentQuestion) = answer {
        api.declineQuestion(question.id)
        afterQuestion(question)
    }

    private suspend fun afterQuestion(question: AgentQuestion) {
        val item = _open.value?.item ?: return
        val left = api.questionsFor(item).filterNot { it.id == question.id }
        if (left.isEmpty()) {
            repository.forgetItem(item.id)
            close()
        } else {
            _open.value = OpenItem(item, ItemDetail.Questions(left))
        }
    }

    fun answerHeadsDown(question: HeadsDownQuestion, answer: HeadsDownAnswer) = answer {
        api.answerHeadsDown(question.id, answer)
        _open.value?.item?.let { repository.forgetItem(it.id) }
        close()
    }

    fun dismissHeadsDown(question: HeadsDownQuestion) = answer {
        api.dismissHeadsDown(question.id)
        _open.value?.item?.let { repository.forgetItem(it.id) }
        close()
    }

    /** Takes the item off the list. An unanswered question still waits for an answer. */
    fun dismiss(item: AttentionItem) = answer {
        api.setAttentionStatus(item.id, "dismissed")
        repository.forgetItem(item.id)
        if (_open.value?.item?.id == item.id) close()
    }

    fun markRead(item: AttentionItem) = answer {
        api.setAttentionStatus(item.id, "read")
        repository.forgetItem(item.id)
        close()
    }

    fun answerApproval(approval: ServerApproval, approve: Boolean) = answer {
        try {
            api.answerApproval(approval.id, approve)
        } catch (e: ApiException) {
            // 409: another device answered first, or it timed out.
            if (e.status != 409) throw e
            _message.value = e.detail ?: "It was already answered."
        }
        repository.forgetApproval(approval.id)
    }

    private fun answer(block: suspend () -> Unit) {
        if (_busy.value) return
        _busy.value = true
        viewModelScope.launch {
            try {
                act("Couldn't send that", block)
            } finally {
                _busy.value = false
            }
        }
    }

    private suspend fun act(failure: String, block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (_: ReauthCancelledException) {
            // The user closed the code prompt; nothing was sent.
        } catch (e: Exception) {
            _message.value = "$failure: ${e.message}"
        }
    }
}

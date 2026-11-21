package dev.yarvis.android

import dev.yarvis.android.api.AgentQuestion
import dev.yarvis.android.api.AttentionApi
import dev.yarvis.android.api.AttentionItem
import dev.yarvis.android.api.ChatApi
import dev.yarvis.android.api.ChatEvent
import dev.yarvis.android.api.ChatMessage
import dev.yarvis.android.api.ChatRequest
import dev.yarvis.android.api.ChatSession
import dev.yarvis.android.api.HeadsDownAnswer
import dev.yarvis.android.api.HeadsDownQuestion
import dev.yarvis.android.api.ModelInfo
import dev.yarvis.android.api.PermissionDecision
import dev.yarvis.android.api.PermissionRequest
import dev.yarvis.android.api.ProviderInfo
import dev.yarvis.android.api.QuestionAnswer
import dev.yarvis.android.api.ServerApproval
import dev.yarvis.android.data.ChatModelPrefs
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow

fun item(id: String, seq: Long, status: String = "pending", kind: String = "info", sessionKey: String? = null, source: String = "system") =
    AttentionItem(
        id = id, seq = seq, source = source, sessionKey = sessionKey, kind = kind, title = "Item $id",
        status = status, createdAt = "2026-11-20T10:00:00.000Z", updatedAt = "2026-11-20T10:00:00.000Z",
    )

fun approval(id: String) = ServerApproval(id, "git.sign", "Sign a commit ($id)", null, 1, 2)

/**
 * A scripted chat server. Each turn's events come from [turnEvents], a channel
 * the test feeds, so a test decides when the turn moves on.
 */
class FakeChatApi : ChatApi {
    val providerList = mutableListOf(
        ProviderInfo("off", "Offline", listOf(ModelInfo("x")), available = false),
        ProviderInfo("anthropic", "Anthropic", listOf(ModelInfo("claude-sonnet-5-5"), ModelInfo("claude-opus-5-5")), available = true),
    )
    val stored = mutableListOf<ChatMessage>()
    val requests = mutableListOf<ChatRequest>()
    val approvalAnswers = mutableListOf<Pair<String, Boolean>>()
    var turnEvents = Channel<ChatEvent>(Channel.UNLIMITED)
    var approvalError: Exception? = null
    var created = 0

    override suspend fun providers() = providerList
    override suspend fun sessions() = emptyList<ChatSession>()
    override suspend fun createSession(): ChatSession {
        created++
        return ChatSession("new-$created", null, "", "")
    }
    override suspend fun messages(sessionId: String) = stored.filter { it.sessionId == sessionId }
    override fun streamChat(request: ChatRequest): Flow<ChatEvent> {
        requests += request
        return turnEvents.receiveAsFlow()
    }
    override suspend fun answerToolApproval(toolCallId: String, approved: Boolean) {
        approvalError?.let { throw it }
        approvalAnswers += toolCallId to approved
    }
}

class FakePrefs(var saved: Pair<String, String>? = null) : ChatModelPrefs {
    override suspend fun load() = saved
    override suspend fun save(provider: String, model: String) {
        saved = provider to model
    }
}

class FakeAttentionApi : AttentionApi {
    var pending = mutableListOf<AttentionItem>()
    var pendingApprovals = mutableListOf<ServerApproval>()
    var stream = Channel<AttentionItem>(Channel.UNLIMITED)
    var pendingError: Exception? = null
    var permissionList = mutableListOf<PermissionRequest>()
    var questionList = mutableListOf<AgentQuestion>()
    var delivered = true
    var approvalError: Exception? = null
    val calls = mutableListOf<String>()
    var attentionLoads = 0
    var approvalLoads = 0

    override suspend fun pendingAttention(): List<AttentionItem> {
        attentionLoads++
        pendingError?.let { throw it }
        return pending.toList()
    }
    override fun attentionStream(): Flow<AttentionItem> = stream.receiveAsFlow()
    override suspend fun setAttentionStatus(id: String, status: String) {
        calls += "status:$id:$status"
    }
    override suspend fun permissions(sessionKey: String) = permissionList.filter { it.sessionKey == sessionKey }
    override suspend fun decidePermission(id: String, decision: PermissionDecision): Boolean {
        calls += "permission:$id:$decision"
        permissionList.removeAll { it.id == id }
        return delivered
    }
    override suspend fun questionsFor(item: AttentionItem) = questionList.filter { it.status == "pending" }
    override suspend fun answerQuestion(id: String, answers: List<QuestionAnswer>) {
        calls += "answer:$id:${answers.map { it.selected + listOfNotNull(it.text) }}"
        questionList.replaceAll { if (it.id == id) it.copy(status = "answered") else it }
    }
    override suspend fun declineQuestion(id: String) {
        calls += "decline:$id"
    }
    override suspend fun headsDownQuestion(id: String): HeadsDownQuestion? = null
    override suspend fun answerHeadsDown(id: String, answer: HeadsDownAnswer) {
        calls += "headsdown:$id:${answer.choice}"
    }
    override suspend fun dismissHeadsDown(id: String) {
        calls += "headsdown-dismiss:$id"
    }
    override suspend fun approvals(): List<ServerApproval> {
        approvalLoads++
        return pendingApprovals.toList()
    }
    override suspend fun answerApproval(id: String, approve: Boolean) {
        approvalError?.let { throw it }
        calls += "approval:$id:$approve"
    }
}

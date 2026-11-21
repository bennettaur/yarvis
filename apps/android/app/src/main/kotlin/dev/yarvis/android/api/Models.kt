package dev.yarvis.android.api

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

// Shapes match the server's Rust structs (server/crates/yarvis-server/src) and
// the sidecar's rows as the web types in src/lib describe them. Server times are
// ms since the epoch; sidecar times are ISO-8601 strings.

@Serializable
data class ErrorBody(val error: JsonElement? = null, val detail: String? = null) {
    /** `error` is a string, except a sidecar validation failure, which sends zod's flatten object. */
    val message: String?
        get() = (error as? JsonPrimitive)?.contentOrNull ?: error?.toString()
}

// ---- auth ----

@Serializable
data class Device(
    val deviceId: String,
    val name: String,
    val scopes: List<String> = emptyList(),
    val verifiedAt: Long? = null,
)

@Serializable
data class AuthStatus(val setupRequired: Boolean, val vault: String? = null)

/** Exactly one of [code] and [backupCode] is set. */
@Serializable
data class LoginRequest(
    val passphrase: String,
    val code: String? = null,
    val backupCode: String? = null,
    val deviceName: String,
)

@Serializable
data class SignedIn(val token: String, val device: Device)

@Serializable
data class ReverifyRequest(val code: String)

@Serializable
data class Verified(val verifiedAt: Long)

// ---- chat (sidecar /api/chat) ----

@Serializable
data class ModelInfo(val id: String, val capabilities: List<String> = emptyList())

@Serializable
data class ProviderInfo(
    val id: String,
    val label: String,
    val models: List<ModelInfo> = emptyList(),
    val available: Boolean = false,
)

@Serializable
data class ChatSession(
    val id: String,
    val title: String? = null,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class CreateSession(val title: String? = null)

@Serializable
data class ToolActivity(
    val id: String,
    val name: String,
    val server: String? = null,
    val args: JsonElement? = null,
    /** "pending", "ok", "error" or "denied". */
    val status: String = "pending",
    val result: String? = null,
    val durationMs: Long? = null,
)

@Serializable
data class ChatMessage(
    val id: String,
    val sessionId: String,
    val role: String,
    val content: String,
    val toolCalls: List<ToolActivity>? = null,
    val createdAt: String,
)

@Serializable
data class ChatRequest(
    val sessionId: String,
    val message: String,
    val provider: String,
    val model: String,
)

/** One frame of a turn's SSE stream. Which fields are set depends on [type]. */
@Serializable
data class ChatEvent(
    val type: String,
    val text: String? = null,
    val message: String? = null,
    val detail: String? = null,
    val finishReason: String? = null,
    val steps: Int? = null,
    val reason: String? = null,
    val id: String? = null,
    val toolId: String? = null,
    val name: String? = null,
    val server: String? = null,
    val args: JsonElement? = null,
    val status: String? = null,
    val result: String? = null,
    val durationMs: Long? = null,
)

@Serializable
data class ToolApprovalAnswer(val approved: Boolean)

// ---- attention (sidecar /api/attention) ----

@Serializable
data class AttentionItem(
    val id: String,
    val seq: Long,
    /** "claude-hook", "chat-agent" or "system". */
    val source: String,
    val sessionKey: String? = null,
    val workspaceId: String? = null,
    /** "permission", "idle", "completed", "error", "info" or "question". */
    val kind: String,
    val title: String,
    val body: String? = null,
    /** "pending", "read", "resolved" or "dismissed". */
    val status: String,
    val payload: JsonElement? = null,
    val createdAt: String,
    val updatedAt: String,
) {
    /**
     * The heads-down question this item stands for. A coding agent's `ask_user`
     * can pick its own session key, so `question` items never count.
     */
    val headsDownQuestionId: String?
        get() {
            if (source != "system" || kind == "question") return null
            val key = sessionKey ?: return null
            if (!key.startsWith(HEADS_DOWN_PREFIX)) return null
            return key.removePrefix(HEADS_DOWN_PREFIX).ifEmpty { null }
        }

    val isClaudePermission: Boolean
        get() = kind == "permission" && source == "claude-hook" && sessionKey != null

    val questionId: String?
        get() = ((payload as? JsonObject)?.get("questionId"))?.jsonPrimitive?.contentOrNull

    companion object {
        const val HEADS_DOWN_PREFIX = "heads-down:"
    }
}

@Serializable
data class AttentionStreamEvent(val type: String, val item: AttentionItem? = null)

@Serializable
data class AttentionPatch(val status: String)

/** A Claude Code permission prompt held by the sidecar while its hook waits. */
@Serializable
data class PermissionRequest(
    val id: String,
    val sessionKey: String,
    val workspaceId: String? = null,
    val workspaceName: String? = null,
    val toolName: String,
    val toolInput: JsonObject = JsonObject(emptyMap()),
    val cwd: String? = null,
    val lastPrompt: String? = null,
    val createdAt: String,
)

/** Body of `POST /api/attention/permissions/{id}`, tagged by `behavior`. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("behavior")
sealed interface PermissionDecision {
    @Serializable
    @SerialName("allow")
    data object Allow : PermissionDecision

    @Serializable
    @SerialName("deny")
    data class Deny(val message: String? = null) : PermissionDecision

    /** For AskUserQuestion prompts: one answer per question, keyed by the question's text. */
    @Serializable
    @SerialName("answer")
    data class Answer(val answers: Map<String, String>) : PermissionDecision
}

@Serializable
data class QuestionOption(val label: String, val description: String? = null)

@Serializable
data class QuestionItem(
    val question: String,
    val header: String? = null,
    val options: List<QuestionOption>? = null,
    val multiSelect: Boolean = false,
)

@Serializable
data class QuestionContext(val task: String, val reason: String? = null)

/** An `ask_user` question from the assistant or a coding agent. */
@Serializable
data class AgentQuestion(
    val id: String,
    val sessionKey: String? = null,
    val context: QuestionContext,
    val questions: List<QuestionItem>,
    /** "pending", "answered" or "declined". */
    val status: String,
    val createdAt: String,
)

@Serializable
data class QuestionAnswer(val selected: List<String>, val text: String? = null)

@Serializable
data class AnswerQuestions(val answers: List<QuestionAnswer>)

@Serializable
data class HeadsDownQuestion(
    val id: String,
    /** "question" or "approval"; an approval's options are "approve" and "deny". */
    val kind: String,
    val question: String,
    val situation: String? = null,
    val options: List<String> = emptyList(),
    val action: String? = null,
    val toolArgs: JsonElement? = null,
    /** "open", "answered" or "dismissed". */
    val status: String,
    val createdAt: String,
)

@Serializable
data class HeadsDownAnswer(val choice: String? = null, val answer: String? = null)

// ---- server approvals and events ----

/** A server approval (`GET /api/approvals`), such as a git signature. */
@Serializable
data class ServerApproval(
    val id: String,
    /** Names the requester, such as `git.sign`. Open-ended: show [summary]. */
    val kind: String,
    val summary: String,
    val data: JsonElement? = null,
    val createdAt: Long,
    val expiresAt: Long,
)

@Serializable
data class ApprovalAnswer(val approve: Boolean)

@Serializable
data class ServerEvent(
    val seq: Long,
    val at: Long,
    val deviceId: String? = null,
    val kind: String,
    val data: JsonElement? = null,
)

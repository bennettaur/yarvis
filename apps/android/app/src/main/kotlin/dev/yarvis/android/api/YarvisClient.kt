package dev.yarvis.android.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody

/** Asks the user for a code from their authenticator app, or null if they cancel. */
fun interface CodePrompt {
    suspend fun requestCode(): String?
}

/** Sign-in routes. They need no token. */
class AuthClient(private val baseUrl: HttpUrl, private val http: OkHttpClient) {
    suspend fun status(): AuthStatus = Rest(baseUrl, http, token = null).get("api/auth/status", AuthStatus.serializer())

    suspend fun login(request: LoginRequest): SignedIn =
        Rest(baseUrl, http, token = null).post("api/auth/login", request, LoginRequest.serializer(), SignedIn.serializer())
}

interface ChatApi {
    suspend fun providers(): List<ProviderInfo>
    suspend fun sessions(): List<ChatSession>
    suspend fun createSession(): ChatSession
    suspend fun messages(sessionId: String): List<ChatMessage>

    /** The turn's events. Cancelling the collector stops the turn. */
    fun streamChat(request: ChatRequest): Flow<ChatEvent>
    suspend fun answerToolApproval(toolCallId: String, approved: Boolean)
}

interface AttentionApi {
    suspend fun pendingAttention(): List<AttentionItem>

    /** Live item changes. Forward-only: after a drop, reload with [pendingAttention]. */
    fun attentionStream(): Flow<AttentionItem>
    suspend fun setAttentionStatus(id: String, status: String)
    suspend fun permissions(sessionKey: String): List<PermissionRequest>

    /** False when the prompt was already settled elsewhere, such as in the terminal. */
    suspend fun decidePermission(id: String, decision: PermissionDecision): Boolean
    suspend fun questionsFor(item: AttentionItem): List<AgentQuestion>
    suspend fun answerQuestion(id: String, answers: List<QuestionAnswer>)
    suspend fun declineQuestion(id: String)
    suspend fun headsDownQuestion(id: String): HeadsDownQuestion?
    suspend fun answerHeadsDown(id: String, answer: HeadsDownAnswer)
    suspend fun dismissHeadsDown(id: String)
    suspend fun approvals(): List<ServerApproval>
    suspend fun answerApproval(id: String, approve: Boolean)
}

/**
 * The signed-in API: the server's own routes, and the sidecar's behind
 * `/api/sidecar`. Answers that act on the user's behalf go through
 * [withFreshAuth], so a server that wants a recent code gets one and the
 * request is retried once.
 */
class YarvisClient(
    private val baseUrl: HttpUrl,
    private val token: String,
    http: OkHttpClient,
    /** For the SSE streams and terminal sockets, which need no read timeout. */
    private val streamHttp: OkHttpClient = http,
    private val codePrompt: CodePrompt,
) : ChatApi, AttentionApi, WorkspacesApi, PtyApi {
    private val rest = Rest(baseUrl, http, token)

    /**
     * Revokes this device on the server, so the token stops working everywhere.
     * Any valid token may revoke itself with no code, so this deliberately skips
     * [withFreshAuth]. A 401, or a 404 when another device revoked it a moment
     * earlier, means the token is already gone, which is the outcome sign-out wants.
     */
    suspend fun revokeSelf() {
        try {
            rest.delete("api/devices/me")
        } catch (e: ApiException) {
            if (e.status != 401 && e.status != 404) throw e
        }
    }

    suspend fun reverify(code: String): Verified =
        rest.post("api/auth/reverify", ReverifyRequest(code), ReverifyRequest.serializer(), Verified.serializer())

    internal suspend fun <T> withFreshAuth(block: suspend () -> T): T {
        try {
            return block()
        } catch (e: ApiException) {
            if (!e.isReauthRequired) throw e
        }
        var attempt = 0
        while (true) {
            val code = codePrompt.requestCode() ?: throw ReauthCancelledException()
            try {
                reverify(code)
                break
            } catch (e: ApiException) {
                // A mistyped or expired code is a 403; let the user try again a few times.
                if (e.status != 403 || ++attempt >= MAX_CODE_ATTEMPTS) throw e
            }
        }
        return block()
    }

    // ---- chat ----

    override suspend fun providers(): List<ProviderInfo> =
        rest.get("$SIDECAR/chat/providers?capability=chat", ListSerializer(ProviderInfo.serializer()))

    override suspend fun sessions(): List<ChatSession> =
        rest.get("$SIDECAR/chat/sessions", ListSerializer(ChatSession.serializer()))

    override suspend fun createSession(): ChatSession =
        rest.post("$SIDECAR/chat/sessions", CreateSession(), CreateSession.serializer(), ChatSession.serializer())

    override suspend fun messages(sessionId: String): List<ChatMessage> =
        rest.get("$SIDECAR/chat/sessions/${encode(sessionId)}/messages", ListSerializer(ChatMessage.serializer()))

    override fun streamChat(request: ChatRequest): Flow<ChatEvent> {
        val call = streamHttp.newCall(
            rest.request("$SIDECAR/chat")
                .header("Accept", "text/event-stream")
                .post(rest.json(request, ChatRequest.serializer()))
                .build(),
        )
        return sseFlow(call).mapNotNull { runCatching { YarvisJson.decodeFromString(ChatEvent.serializer(), it) }.getOrNull() }
    }

    override suspend fun answerToolApproval(toolCallId: String, approved: Boolean) {
        withFreshAuth {
            rest.post(
                "$SIDECAR/chat/approvals/${encode(toolCallId)}",
                ToolApprovalAnswer(approved),
                ToolApprovalAnswer.serializer(),
                Unit.serializer(),
            )
        }
    }

    // ---- attention ----

    override suspend fun pendingAttention(): List<AttentionItem> =
        rest.get("$SIDECAR/attention?status=pending", ListSerializer(AttentionItem.serializer()))

    override fun attentionStream(): Flow<AttentionItem> {
        val call = streamHttp.newCall(rest.request("$SIDECAR/attention/stream").header("Accept", "text/event-stream").build())
        return sseFlow(call).mapNotNull {
            runCatching { YarvisJson.decodeFromString(AttentionStreamEvent.serializer(), it) }.getOrNull()?.item
        }
    }

    override suspend fun setAttentionStatus(id: String, status: String) {
        rest.patch("$SIDECAR/attention/${encode(id)}", AttentionPatch(status), AttentionPatch.serializer())
    }

    override suspend fun permissions(sessionKey: String): List<PermissionRequest> = rest.get(
        "$SIDECAR/attention/permissions?sessionKey=${encode(sessionKey)}",
        ListSerializer(PermissionRequest.serializer()),
    )

    override suspend fun decidePermission(id: String, decision: PermissionDecision): Boolean = try {
        withFreshAuth {
            rest.post("$SIDECAR/attention/permissions/${encode(id)}", decision, PermissionDecision.serializer(), Unit.serializer())
        }
        true
    } catch (e: ApiException) {
        // 410: the hook stopped waiting (answered in the terminal, or the session moved on).
        if (e.status == 410) false else throw e
    }

    override suspend fun questionsFor(item: AttentionItem): List<AgentQuestion> {
        // A session's questions coalesce into one item, so a keyed item lists them all.
        val key = item.sessionKey
        if (key != null) {
            return rest.get("$SIDECAR/questions?sessionKey=${encode(key)}", ListSerializer(AgentQuestion.serializer()))
        }
        val id = item.questionId ?: return emptyList()
        val question = rest.get("$SIDECAR/questions/${encode(id)}", AgentQuestion.serializer())
        return if (question.status == "pending") listOf(question) else emptyList()
    }

    override suspend fun answerQuestion(id: String, answers: List<QuestionAnswer>) {
        withFreshAuth {
            rest.post("$SIDECAR/questions/${encode(id)}/answer", AnswerQuestions(answers), AnswerQuestions.serializer(), Unit.serializer())
        }
    }

    override suspend fun declineQuestion(id: String) {
        withFreshAuth { rest.postEmpty("$SIDECAR/questions/${encode(id)}/decline") }
    }

    override suspend fun headsDownQuestion(id: String): HeadsDownQuestion? =
        rest.get("$SIDECAR/heads-down/questions", ListSerializer(HeadsDownQuestion.serializer())).firstOrNull { it.id == id }

    override suspend fun answerHeadsDown(id: String, answer: HeadsDownAnswer) {
        withFreshAuth {
            rest.post("$SIDECAR/heads-down/questions/${encode(id)}/answer", answer, HeadsDownAnswer.serializer(), Unit.serializer())
        }
    }

    override suspend fun dismissHeadsDown(id: String) {
        withFreshAuth { rest.postEmpty("$SIDECAR/heads-down/questions/${encode(id)}/dismiss") }
    }

    override suspend fun approvals(): List<ServerApproval> =
        rest.get("api/approvals", ListSerializer(ServerApproval.serializer()))

    override suspend fun answerApproval(id: String, approve: Boolean) {
        withFreshAuth {
            rest.post("api/approvals/${encode(id)}", ApprovalAnswer(approve), ApprovalAnswer.serializer(), Unit.serializer())
        }
    }

    // ---- workspaces ----
    // No route here is fresh-only on the server or the sidecar, so none goes through withFreshAuth.

    override suspend fun workspaces(badges: Boolean): List<WorkspaceSummary> = rest.get(
        "$SIDECAR/workspaces${if (badges) "?badges=1" else ""}",
        ListSerializer(WorkspaceSummary.serializer()),
    )

    override suspend fun workspace(id: String, viewing: Boolean): WorkspaceDetail = rest.get(
        "$SIDECAR/workspaces/${encode(id)}${if (viewing) "?viewing=1" else ""}",
        WorkspaceDetail.serializer(),
    )

    override suspend fun createWorkspace(new: NewWorkspace): WorkspaceSummary {
        // The sidecar wants a task id to be a uuid, so a blank one is a 400.
        val body = new.copy(
            existingBranches = new.existingBranches?.filterValues { it.isNotEmpty() }?.takeIf { it.isNotEmpty() },
            taskId = new.taskId?.takeIf { it.isNotEmpty() },
        )
        return rest.post("$SIDECAR/workspaces", body, NewWorkspace.serializer(), WorkspaceSummary.serializer())
    }

    override fun provision(id: String): Flow<ProvisionEvent> {
        val call = streamHttp.newCall(
            rest.request("$SIDECAR/workspaces/${encode(id)}/provision")
                .header("Accept", "text/event-stream")
                .post(ByteArray(0).toRequestBody(null))
                .build(),
        )
        return sseFlow(call).mapNotNull(::decodeProvisionEvent)
    }

    override suspend fun ignoreWorkspaceError(id: String) {
        rest.postEmpty("$SIDECAR/workspaces/${encode(id)}/ignore-error")
    }

    override suspend fun archiveWorkspace(id: String, request: ArchiveRequest) {
        rest.post("$SIDECAR/workspaces/${encode(id)}/archive", request, ArchiveRequest.serializer(), Unit.serializer())
    }

    override suspend fun repos(): List<Repo> = rest.get("$SIDECAR/repos", ListSerializer(Repo.serializer()))

    override suspend fun repoBranches(repoId: String): List<String> =
        rest.get("$SIDECAR/repos/${encode(repoId)}/branches", ListSerializer(String.serializer()))

    override suspend fun openTasks(): List<WorkspaceTask> =
        rest.get("$SIDECAR/tasks?status=open", ListSerializer(WorkspaceTask.serializer()))

    override suspend fun agentConfig(): AgentConfig = core("get_agent_config", AgentConfig.serializer())

    override suspend fun startAgent(workspace: WorkspaceDetail, harness: String?) {
        core(
            "pty_start_claude",
            Unit.serializer(),
            buildJsonObject {
                put("workspaceId", workspace.id)
                put("cwd", workspace.rootPath)
                put("name", workspace.name)
                put("remoteControl", false)
                if (harness != null) put("harness", harness)
            },
        )
    }

    override suspend fun stopAgent(workspaceId: String) {
        rest.postEmpty("$SIDECAR/workspaces/${encode(workspaceId)}/agent/stop")
    }

    // ---- terminals ----

    override suspend fun ptySessions(): List<PtySession> = rest.get("api/pty", PtySessionList.serializer()).sessions

    override suspend fun ptyKill(id: String) {
        core("pty_kill", Unit.serializer(), buildJsonObject { put("id", id) })
    }

    override suspend fun ptyExists(id: String): Boolean =
        core("pty_exists", Boolean.serializer(), buildJsonObject { put("id", id) })

    override fun attachPty(
        sessionId: String,
        cols: Int,
        rows: Int,
        cwd: String?,
        mayReconnect: (suspend () -> Boolean)?,
    ): PtyConnection = OkHttpPtyConnection(baseUrl, token, streamHttp, sessionId, cols, rows, cwd, mayReconnect)

    /** A server core command: `POST api/core/<command>` with its arguments as one JSON object. */
    private suspend fun <T> core(command: String, response: DeserializationStrategy<T>, args: JsonObject = JsonObject(emptyMap())): T =
        rest.post("api/core/${encode(command)}", args, JsonObject.serializer(), response)

    private companion object {
        const val SIDECAR = "api/sidecar/api"
        const val MAX_CODE_ATTEMPTS = 3

        /**
         * Percent-encodes one path segment or query value. A `.` or `..` id is
         * refused, since URL resolution would turn it into a different route.
         */
        fun encode(value: String): String {
            require(value != "." && value != "..") { "not an id: $value" }
            return java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
        }
    }
}

/** JSON over HTTP against one server, with or without a device token. */
internal class Rest(private val baseUrl: HttpUrl, private val http: OkHttpClient, private val token: String?) {
    fun request(path: String): Request.Builder {
        val url = baseUrl.resolve(path) ?: throw IllegalArgumentException("bad path: $path")
        val builder = Request.Builder().url(url)
        if (token != null) builder.header("Authorization", "Bearer $token")
        return builder
    }

    fun <T> json(body: T, serializer: SerializationStrategy<T>): RequestBody =
        YarvisJson.encodeToString(serializer, body).toRequestBody(JSON)

    suspend fun <T> get(path: String, responseSerializer: DeserializationStrategy<T>): T = send(request(path).get().build(), responseSerializer)

    suspend fun <B, T> post(path: String, body: B, bodySerializer: SerializationStrategy<B>, responseSerializer: DeserializationStrategy<T>): T =
        send(request(path).post(json(body, bodySerializer)).build(), responseSerializer)

    suspend fun postEmpty(path: String) {
        send(request(path).post(ByteArray(0).toRequestBody(null)).build(), Unit.serializer())
    }

    suspend fun <B> patch(path: String, body: B, bodySerializer: SerializationStrategy<B>) {
        send(request(path).patch(json(body, bodySerializer)).build(), Unit.serializer())
    }

    suspend fun delete(path: String) {
        send(request(path).delete().build(), Unit.serializer())
    }

    private suspend fun <T> send(request: Request, responseSerializer: DeserializationStrategy<T>): T {
        val response = http.newCall(request).await()
        return response.use {
            if (!it.isSuccessful) throw it.toApiException()
            @Suppress("UNCHECKED_CAST")
            if (responseSerializer == Unit.serializer()) return Unit as T
            val text = withContext(Dispatchers.IO) { it.body.string() }
            YarvisJson.decodeFromString(responseSerializer, text)
        }
    }

    private companion object {
        val JSON = "application/json".toMediaType()
    }
}

@Serializable
private class PtySessionList(val sessions: List<PtySession>)

/** One provision message, or null for one this build doesn't know or can't read. Missing fields read as "". */
internal fun decodeProvisionEvent(data: String): ProvisionEvent? {
    val message = runCatching { YarvisJson.parseToJsonElement(data).jsonObject }.getOrNull() ?: return null
    fun field(key: String) = (message[key] as? JsonPrimitive)?.contentOrNull.orEmpty()
    val repoId = field("workspaceRepoId")
    return when (field("type")) {
        "repo-start" -> ProvisionEvent.RepoStart(repoId, field("repo"))
        "log" -> ProvisionEvent.Log(repoId, field("text"))
        "repo-done" -> ProvisionEvent.RepoDone(repoId, field("status"))
        "repo-error" -> ProvisionEvent.RepoError(repoId, field("message"))
        "done" -> ProvisionEvent.Done(field("status"))
        "error" -> ProvisionEvent.Error(field("message"))
        else -> null
    }
}

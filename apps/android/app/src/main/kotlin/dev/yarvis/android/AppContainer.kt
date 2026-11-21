package dev.yarvis.android

import android.content.Context
import android.os.Build
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import dev.yarvis.android.api.AuthClient
import dev.yarvis.android.api.LoginRequest
import dev.yarvis.android.api.ServerEventsSocket
import dev.yarvis.android.api.ServerUrl
import dev.yarvis.android.api.YarvisClient
import dev.yarvis.android.data.AttentionRepository
import dev.yarvis.android.data.ChatModelPrefs
import dev.yarvis.android.data.CodePromptState
import dev.yarvis.android.data.SavedSession
import dev.yarvis.android.data.SessionStore
import dev.yarvis.android.notify.AttentionNotifier
import dev.yarvis.android.ui.signin.SignInGateway
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.OkHttpClient

/** Everything a signed-in screen needs. */
class SignedInSession(
    val serverUrl: HttpUrl,
    val client: YarvisClient,
    val attention: AttentionRepository,
)

sealed interface AuthState {
    data object Loading : AuthState
    data class SignedOut(val lastServerUrl: String?) : AuthState
    data class SignedIn(val session: SignedInSession) : AuthState
}

/** The app's singletons: storage, HTTP, the signed-in session and its live streams. */
class AppContainer(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val store = SessionStore(context)
    val codePrompt = CodePromptState()
    val notifier = AttentionNotifier(context)

    private val http: OkHttpClient = OkHttpClient.Builder()
        // Server-sent event streams and long tool approvals sit quiet for minutes.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        // Notices a dead events socket; the server answers pings without app code.
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    private val _auth = MutableStateFlow<AuthState>(AuthState.Loading)
    val auth: StateFlow<AuthState> = _auth.asStateFlow()

    val chatModelPrefs = object : ChatModelPrefs {
        override suspend fun load() = store.chatModel()
        override suspend fun save(provider: String, model: String) = store.saveChatModel(provider, model)
    }

    val signInGateway = object : SignInGateway {
        override suspend fun setupRequired(server: HttpUrl) = AuthClient(server, http).status().setupRequired

        override suspend fun signIn(server: HttpUrl, request: LoginRequest) {
            val signedIn = AuthClient(server, http).login(request)
            store.save(SavedSession(server.toString(), signedIn.token))
            begin(server, signedIn.token)
        }

        override val defaultDeviceName: String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
    }

    private var stopStreamsJob: Job? = null

    init {
        scope.launch {
            val saved = store.load()
            val url = saved?.let { ServerUrl.parse(it.serverUrl).getOrNull() }
            if (saved != null && url != null) begin(url, saved.token) else _auth.value = AuthState.SignedOut(store.lastServerUrl())
        }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                notifier.foreground = true
                stopStreamsJob?.cancel()
                (auth.value as? AuthState.SignedIn)?.session?.attention?.start()
            }

            override fun onStop(owner: LifecycleOwner) {
                notifier.foreground = false
                // Keep listening for a while after the app leaves the screen, so a
                // prompt that arrives just after still notifies. Past that, real
                // background delivery would need push (see the README).
                stopStreamsJob = scope.launch {
                    delay(BACKGROUND_GRACE_MS)
                    (auth.value as? AuthState.SignedIn)?.session?.attention?.stop()
                }
            }
        })
    }

    private fun begin(server: HttpUrl, token: String) {
        val authed = http.newBuilder()
            .addInterceptor { chain ->
                val response = chain.proceed(chain.request())
                if (response.code == 401) scope.launch { forget() }
                response
            }
            .build()
        val client = YarvisClient(server, token, authed, codePrompt)
        val events = ServerEventsSocket(server, token, http)
        val attention = AttentionRepository(client, events::signals, scope, onSignedOut = { scope.launch { forget() } })
        notifier.follow(scope, attention.arrivals)
        _auth.value = AuthState.SignedIn(SignedInSession(server, client, attention))
        attention.start()
    }

    /** Revokes the device on the server when it can, then forgets the token. */
    fun signOut() {
        val session = (auth.value as? AuthState.SignedIn)?.session ?: return
        scope.launch {
            runCatching { session.client.revokeSelf() }
            forget()
        }
    }

    private suspend fun forget() {
        val session = (auth.value as? AuthState.SignedIn)?.session ?: return
        session.attention.stop()
        notifier.stopFollowing()
        store.clearToken()
        _auth.value = AuthState.SignedOut(session.serverUrl.toString())
    }

    private companion object {
        const val BACKGROUND_GRACE_MS = 10 * 60 * 1000L
    }
}

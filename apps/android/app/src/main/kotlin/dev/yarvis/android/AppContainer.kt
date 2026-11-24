package dev.yarvis.android

import android.content.Context
import android.os.Build
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
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
import java.util.UUID
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient

/** Everything a signed-in screen needs. [id] tells one sign-in from the next, even to the same server. */
class SignedInSession(
    val serverUrl: HttpUrl,
    val client: YarvisClient,
    val attention: AttentionRepository,
    val id: String = UUID.randomUUID().toString(),
)

sealed interface AuthState {
    data object Loading : AuthState
    /** [notice] says what the sign-out couldn't do, such as revoke the device. */
    data class SignedOut(val lastServerUrl: String?, val notice: String? = null) : AuthState
    data class SignedIn(val session: SignedInSession) : AuthState
}

/** The app's singletons: storage, HTTP, the signed-in session and its live streams. */
class AppContainer(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val store = SessionStore(context)
    val codePrompt = CodePromptState()
    val notifier = AttentionNotifier(context)

    /** For ordinary requests: a stalled one fails instead of hanging the screen. */
    private val http: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    private val streamHttp: OkHttpClient = http.newBuilder()
        .callTimeout(0, TimeUnit.MILLISECONDS)
        // Server-sent event streams sit quiet for minutes, such as while a tool approval waits.
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
        override suspend fun isSetupRequired(server: HttpUrl) = AuthClient(server, http).status().setupRequired

        override suspend fun signIn(server: HttpUrl, request: LoginRequest) {
            val signedIn = AuthClient(server, http).login(request)
            store.save(SavedSession(server.toString(), signedIn.token))
            begin(server, signedIn.token)
        }

        override val defaultDeviceName: String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
    }

    private var stopStreamsJob: Job? = null

    /** The session [signOut] is revoking, so a 401 or 4401 it causes is not a second sign-out. */
    private var signingOut: SignedInSession? = null

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
        lateinit var session: SignedInSession
        val signOutOn401 = Interceptor { chain ->
            val response = chain.proceed(chain.request())
            if (response.code == 401) scope.launch { forget(session) }
            response
        }
        val client = YarvisClient(
            server,
            token,
            http.newBuilder().addInterceptor(signOutOn401).build(),
            streamHttp = streamHttp.newBuilder().addInterceptor(signOutOn401).build(),
            codePrompt = codePrompt,
        )
        val events = ServerEventsSocket(server, token, streamHttp)
        val attention = AttentionRepository(client, events::signals, scope, onSignedOut = { scope.launch { forget(session) } })
        session = SignedInSession(server, client, attention)
        notifier.follow(scope, attention.arrivals)
        _auth.value = AuthState.SignedIn(session)
        if (ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) attention.start()
    }

    /** Revokes the device on the server when it can, then forgets the token. */
    fun signOut() {
        val session = (auth.value as? AuthState.SignedIn)?.session ?: return
        if (signingOut === session) return
        signingOut = session
        // Close the streams first so they don't reconnect on the 4401. The guard is what
        // keeps that 4401, or a 401, from signing out a second time.
        session.attention.stop()
        scope.launch {
            val revoked = runCatching { session.client.revokeSelf() }.isSuccess
            forget(
                session,
                notice = if (revoked) {
                    null
                } else {
                    "Signed out here, but this device is still on the server. Revoke it from the devices list in the web UI."
                },
                bySignOut = true,
            )
        }
    }

    /**
     * Signs [session] out. A late 401 from an earlier session leaves the current
     * one alone, and while [signOut] runs, only it decides how the sign-out ends.
     */
    private suspend fun forget(session: SignedInSession, notice: String? = null, bySignOut: Boolean = false) {
        if ((auth.value as? AuthState.SignedIn)?.session !== session) return
        if (signingOut === session && !bySignOut) return
        signingOut = null
        // Signed out before the first suspension, so a second forget() that was
        // waiting can't pass the identity check above and overwrite the notice.
        _auth.value = AuthState.SignedOut(session.serverUrl.toString(), notice)
        session.attention.stop()
        notifier.stopFollowing()
        store.clearToken()
    }

    private companion object {
        const val BACKGROUND_GRACE_MS = 10 * 60 * 1000L
    }
}

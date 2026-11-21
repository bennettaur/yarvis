package dev.yarvis.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.yarvis.android.ui.CodePromptDialog
import dev.yarvis.android.ui.attention.AttentionScreen
import dev.yarvis.android.ui.attention.AttentionViewModel
import dev.yarvis.android.ui.chat.ChatListScreen
import dev.yarvis.android.ui.chat.ChatListViewModel
import dev.yarvis.android.ui.chat.ChatThreadScreen
import dev.yarvis.android.ui.chat.ChatThreadViewModel
import dev.yarvis.android.ui.signin.SignInScreen
import dev.yarvis.android.ui.signin.SignInViewModel
import java.util.UUID

class MainActivity : ComponentActivity() {
    private val openAttention = mutableStateOf(false)

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Only a fresh launch follows the notification's extra; a rotation keeps the user's tab.
        if (savedInstanceState == null) openAttention.value = intent.getBooleanExtra(EXTRA_OPEN_ATTENTION, false)
        val container = (application as YarvisApp).container
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                YarvisRoot(container, openAttention, ::askForNotifications)
            }
        }
    }

    /** Asked once signed in, when it's clear what the notifications are for. */
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(EXTRA_OPEN_ATTENTION, false)) openAttention.value = true
    }

    companion object {
        const val EXTRA_OPEN_ATTENTION = "open_attention"
    }
}

private enum class Tab { Chat, Attention }

/** A thread that gets its session when the first message is sent. Each "New chat" gets its own. */
private const val NEW_THREAD_PREFIX = "new:"

private fun newThreadKey() = NEW_THREAD_PREFIX + UUID.randomUUID()

@Composable
private fun YarvisRoot(container: AppContainer, openAttention: MutableState<Boolean>, askForNotifications: () -> Unit) {
    val auth by container.auth.collectAsStateWithLifecycle()
    when (val state = auth) {
        AuthState.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        is AuthState.SignedOut -> Scaffold { padding ->
            val vm = viewModel(key = "signin:${state.lastServerUrl}") { SignInViewModel(container.signInGateway, state.lastServerUrl) }
            SignInScreen(vm, state.notice, Modifier.padding(padding))
        }
        is AuthState.SignedIn -> {
            LaunchedEffect(Unit) { askForNotifications() }
            SignedInScreens(container, state.session, openAttention)
        }
    }
    CodePromptDialog(container.codePrompt)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SignedInScreens(
    container: AppContainer,
    session: SignedInSession,
    openAttention: MutableState<Boolean>,
) {
    var tab by rememberSaveable { mutableStateOf(Tab.Chat) }
    // A thread is open when this holds a session id, or a key made by newThreadKey().
    var thread by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(openAttention.value) {
        if (openAttention.value) {
            tab = Tab.Attention
            openAttention.value = false
        }
    }
    val attention by session.attention.state.collectAsStateWithLifecycle()
    val pending = attention.items.size + attention.approvals.size

    DisposableEffect(tab) {
        container.notifier.attentionVisible = tab == Tab.Attention
        onDispose { container.notifier.attentionVisible = false }
    }
    BackHandler(enabled = thread != null) { thread = null }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (tab == Tab.Chat) "Chat" else "Attention") },
                actions = { TextButton(onClick = container::signOut) { Text("Sign out") } },
            )
        },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = tab == Tab.Chat,
                    onClick = { tab = Tab.Chat },
                    icon = { Icon(Icons.Filled.Email, contentDescription = null) },
                    label = { Text("Chat") },
                )
                NavigationBarItem(
                    selected = tab == Tab.Attention,
                    onClick = { tab = Tab.Attention },
                    icon = {
                        BadgedBox(badge = { if (pending > 0) Badge { Text("$pending") } }) {
                            Icon(Icons.Filled.Notifications, contentDescription = null)
                        }
                    },
                    label = { Text("Attention") },
                )
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when (tab) {
                Tab.Chat -> {
                    val open = thread
                    if (open == null) {
                        val vm = viewModel(key = "chats:${session.id}") { ChatListViewModel(session.client) }
                        ChatListScreen(vm, onOpen = { thread = it ?: newThreadKey() })
                    } else {
                        val vm = viewModel(key = "thread:${session.id}:$open") {
                            ChatThreadViewModel(session.client, container.chatModelPrefs, open.takeUnless { it.startsWith(NEW_THREAD_PREFIX) })
                        }
                        ChatThreadScreen(vm)
                    }
                }
                Tab.Attention -> {
                    val vm = viewModel(key = "attention:${session.id}") {
                        AttentionViewModel(session.client, session.attention)
                    }
                    AttentionScreen(vm)
                }
            }
        }
    }
}

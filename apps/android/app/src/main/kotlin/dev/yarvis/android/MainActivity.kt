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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
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
import dev.yarvis.android.ui.terminal.TerminalScreen
import dev.yarvis.android.ui.terminal.TerminalSessionsScreen
import dev.yarvis.android.ui.workspaces.NewWorkspaceScreen
import dev.yarvis.android.ui.workspaces.NewWorkspaceViewModel
import dev.yarvis.android.ui.workspaces.TerminalTarget
import dev.yarvis.android.ui.workspaces.WorkspaceDetailScreen
import dev.yarvis.android.ui.workspaces.WorkspaceDetailViewModel
import dev.yarvis.android.ui.workspaces.WorkspaceListScreen
import dev.yarvis.android.ui.workspaces.WorkspaceListViewModel
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

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

@Serializable
private enum class Tab { Chat, Workspaces, Terminal, Attention }

/** A screen within a tab. Each tab keeps a stack of these, and Back pops it. */
@Serializable
private sealed interface Route {
    @Serializable
    data object ChatList : Route

    /** [key] is a session id, or a key made by newThreadKey(). */
    @Serializable
    data class ChatThread(val key: String) : Route

    @Serializable
    data object WorkspaceList : Route

    /** [name] titles the screen before the workspace loads. */
    @Serializable
    data class Workspace(val id: String, val name: String) : Route

    @Serializable
    data object NewWorkspace : Route

    @Serializable
    data object TerminalSessions : Route

    @Serializable
    data class Terminal(val sessionId: String, val title: String, val cwd: String?) : Route

    @Serializable
    data object Attention : Route
}

private fun Tab.root(): Route = when (this) {
    Tab.Chat -> Route.ChatList
    Tab.Workspaces -> Route.WorkspaceList
    Tab.Terminal -> Route.TerminalSessions
    Tab.Attention -> Route.Attention
}

/** The open tab and every tab's stack, so switching tabs keeps where each one was. */
@Serializable
private data class NavState(
    val tab: Tab = Tab.Chat,
    val stacks: Map<Tab, List<Route>> = Tab.entries.associateWith { listOf(it.root()) },
) {
    val stack: List<Route> get() = stacks[tab] ?: listOf(tab.root())
    val top: Route get() = stack.last()

    fun select(tab: Tab) = copy(tab = tab)

    /** Tapping the open tab again goes back to its first screen. */
    fun reselect() = copy(stacks = stacks + (tab to listOf(tab.root())))

    fun push(route: Route) = copy(stacks = stacks + (tab to stack + route))

    fun replaceTop(route: Route) = copy(stacks = stacks + (tab to stack.dropLast(1) + route))

    fun pop() = if (stack.size > 1) copy(stacks = stacks + (tab to stack.dropLast(1))) else this
}

private val navJson = Json { ignoreUnknownKeys = true }

/** Saved as JSON, so the stacks outlive a rotation and a process restart. */
private val NavStateSaver = Saver<MutableState<NavState>, String>(
    save = { navJson.encodeToString(NavState.serializer(), it.value) },
    restore = { saved -> mutableStateOf(runCatching { navJson.decodeFromString(NavState.serializer(), saved) }.getOrDefault(NavState())) },
)

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
    var nav by rememberSaveable(saver = NavStateSaver) { mutableStateOf(NavState()) }
    LaunchedEffect(openAttention.value) {
        if (openAttention.value) {
            nav = nav.select(Tab.Attention)
            openAttention.value = false
        }
    }
    val attention by session.attention.state.collectAsStateWithLifecycle()
    val pending = attention.items.size + attention.approvals.size

    DisposableEffect(nav.tab) {
        container.notifier.attentionVisible = nav.tab == Tab.Attention
        onDispose { container.notifier.attentionVisible = false }
    }
    BackHandler(enabled = nav.stack.size > 1) { nav = nav.pop() }

    val top = nav.top
    val openTerminal = { target: TerminalTarget -> nav = nav.push(Route.Terminal(target.sessionId, target.title, target.cwd)) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title(top), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    if (nav.stack.size > 1) {
                        IconButton(onClick = { nav = nav.pop() }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
                actions = { TextButton(onClick = container::signOut) { Text("Sign out") } },
            )
        },
        bottomBar = {
            // A terminal gets the whole height; Back leaves it.
            if (top !is Route.Terminal) {
                NavigationBar {
                    for (tab in Tab.entries) {
                        NavigationBarItem(
                            selected = nav.tab == tab,
                            onClick = { nav = if (nav.tab == tab) nav.reselect() else nav.select(tab) },
                            icon = {
                                if (tab == Tab.Attention) {
                                    BadgedBox(badge = { if (pending > 0) Badge { Text("$pending") } }) { TabIcon(tab) }
                                } else {
                                    TabIcon(tab)
                                }
                            },
                            label = { Text(tab.name) },
                        )
                    }
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when (top) {
                Route.ChatList -> {
                    val vm = viewModel(key = "chats:${session.id}") { ChatListViewModel(session.client) }
                    ChatListScreen(vm, onOpen = { nav = nav.push(Route.ChatThread(it ?: newThreadKey())) })
                }
                is Route.ChatThread -> {
                    val vm = viewModel(key = "thread:${session.id}:${top.key}") {
                        ChatThreadViewModel(session.client, container.chatModelPrefs, top.key.takeUnless { it.startsWith(NEW_THREAD_PREFIX) })
                    }
                    ChatThreadScreen(vm)
                }
                Route.WorkspaceList -> {
                    val vm = viewModel(key = "workspaces:${session.id}") { WorkspaceListViewModel(session.client) }
                    WorkspaceListScreen(
                        vm,
                        onOpen = { nav = nav.push(Route.Workspace(it.id, it.name)) },
                        onNew = { nav = nav.push(Route.NewWorkspace) },
                    )
                }
                is Route.Workspace -> {
                    val vm = viewModel(key = "workspace:${session.id}:${top.id}") {
                        WorkspaceDetailViewModel(session.client, session.client, top.id)
                    }
                    WorkspaceDetailScreen(vm, onOpenTerminal = openTerminal)
                }
                Route.NewWorkspace -> {
                    // A fresh form each time it opens, rather than the last one's leftovers.
                    val formKey = rememberSaveable { UUID.randomUUID().toString() }
                    val vm = viewModel(key = "new-workspace:${session.id}:$formKey") { NewWorkspaceViewModel(session.client) }
                    NewWorkspaceScreen(
                        vm,
                        onCreated = { nav = nav.replaceTop(Route.Workspace(it.id, it.name)) },
                        onCancel = { nav = nav.pop() },
                    )
                }
                Route.TerminalSessions -> TerminalSessionsScreen(
                    pty = session.client,
                    onOpen = { sessionId, title -> openTerminal(TerminalTarget(sessionId, title, null)) },
                    viewModelKey = session.id,
                )
                is Route.Terminal -> key(top.sessionId) {
                    TerminalScreen(
                        pty = session.client,
                        sessionId = top.sessionId,
                        title = top.title,
                        cwd = top.cwd,
                        onSignedOut = { container.onSessionRevoked(session) },
                        viewModelKey = session.id,
                    )
                }
                Route.Attention -> {
                    val vm = viewModel(key = "attention:${session.id}") {
                        AttentionViewModel(session.client, session.attention)
                    }
                    AttentionScreen(vm)
                }
            }
        }
    }
}

private fun title(route: Route): String = when (route) {
    Route.ChatList, is Route.ChatThread -> "Chat"
    Route.WorkspaceList -> "Workspaces"
    is Route.Workspace -> route.name
    Route.NewWorkspace -> "New workspace"
    Route.TerminalSessions -> "Terminal"
    is Route.Terminal -> route.title
    Route.Attention -> "Attention"
}

@Composable
private fun TabIcon(tab: Tab) {
    val icon = when (tab) {
        Tab.Chat -> Icons.Filled.Email
        Tab.Workspaces -> Icons.Filled.Build
        Tab.Terminal -> Icons.AutoMirrored.Filled.KeyboardArrowRight
        Tab.Attention -> Icons.Filled.Notifications
    }
    Icon(icon, contentDescription = null)
}

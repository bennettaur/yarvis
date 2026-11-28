package dev.yarvis.android.ui.terminal

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.yarvis.android.api.PtyApi
import dev.yarvis.android.api.PtyIds
import dev.yarvis.android.api.PtySession

@Composable
fun TerminalScreen(
    pty: PtyApi,
    sessionId: String,
    title: String,
    cwd: String?,
    onSignedOut: () -> Unit,
    modifier: Modifier = Modifier,
    viewModelKey: String = "",
) {
    val vm = viewModel(key = "terminal:$viewModelKey:$sessionId") { TerminalViewModel(pty, sessionId, cwd) }
    val state by vm.state.collectAsStateWithLifecycle()
    val signedOut by rememberUpdatedState(onSignedOut)
    LaunchedEffect(state.status) {
        if (state.status == TerminalStatus.SignedOut) signedOut()
    }
    Column(modifier.fillMaxSize().imePadding()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                cwd?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            TextButton(onClick = { vm.changeFontSize(-1) }, enabled = state.fontSize > MIN_FONT_SIZE) { Text("A−") }
            TextButton(onClick = { vm.changeFontSize(1) }, enabled = state.fontSize < MAX_FONT_SIZE) { Text("A+") }
        }
        when (state.status) {
            TerminalStatus.Connecting -> LinearProgressIndicator(Modifier.fillMaxWidth())
            TerminalStatus.Reconnecting -> Banner("Reconnecting…")
            else -> Unit
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            TerminalPage(vm, state.fontSize)
        }
        when (val status = state.status) {
            is TerminalStatus.Exited -> Surface(tonalElevation = 4.dp, modifier = Modifier.fillMaxWidth()) {
                Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        status.code?.let { "The shell exited with code $it." } ?: "The shell exited.",
                        modifier = Modifier.weight(1f),
                    )
                    if (state.canStartNewShell) Button(onClick = vm::startNewShell) { Text("Start a new shell") }
                }
            }
            is TerminalStatus.Failed -> Banner(status.message, error = true)
            else -> Unit
        }
        ExtraKeys(state.ctrlArmed, onKey = vm::press, onCtrl = vm::toggleCtrl)
    }
}

/**
 * The page is recreated with the activity (and after a renderer crash); each
 * new one is filled from the view model's replay buffer.
 */
@Composable
private fun TerminalPage(vm: TerminalViewModel, fontSize: Int) {
    var generation by remember { mutableIntStateOf(0) }
    key(generation) {
        val context = LocalContext.current
        val page = remember {
            lateinit var view: TerminalWebView
            val listener = object : TerminalPageListener {
                override fun onReady() = Unit
                override fun onData(data: String) = vm.onInput(data)
                override fun onBinary(data: String) = vm.onBinary(data)
                override fun onResize(cols: Int, rows: Int) = vm.onViewport(cols, rows)
                override fun onModes(appCursor: Boolean) = vm.onModes(appCursor)
                override fun onTap() {
                    vm.onTap()
                    view.showKeyboard()
                }
                override fun onCrashed() {
                    generation++
                }
            }
            view = TerminalWebView(context, listener, fontSize)
            view
        }
        DisposableEffect(page) {
            vm.attachSink(page)
            onDispose {
                vm.detachSink(page)
                page.destroy()
            }
        }
        LaunchedEffect(page, fontSize) { page.setFontSize(fontSize) }
        AndroidView(factory = { page }, modifier = Modifier.fillMaxSize())
    }
}

@Composable
private fun Banner(text: String, error: Boolean = false) {
    Surface(
        color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(text, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
    }
}

/** Keys the phone keyboard lacks. They never take focus, so the keyboard stays up while they're used. */
@Composable
private fun ExtraKeys(ctrlArmed: Boolean, onKey: (ExtraKey) -> Unit, onCtrl: () -> Unit) {
    val noFocus = Modifier.focusProperties { canFocus = false }
    Surface(tonalElevation = 2.dp, modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            for (key in listOf(ExtraKey.Esc, ExtraKey.Tab, ExtraKey.ShiftTab)) KeyButton(key.label, noFocus) { onKey(key) }
            if (ctrlArmed) {
                FilledTonalButton(onClick = onCtrl, modifier = noFocus) { Text("Ctrl") }
            } else {
                KeyButton("Ctrl", noFocus, onCtrl)
            }
            for (key in ExtraKey.entries.drop(3)) KeyButton(key.label, noFocus) { onKey(key) }
        }
    }
}

@Composable
private fun KeyButton(label: String, modifier: Modifier, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = modifier) { Text(label, fontFamily = FontFamily.Monospace) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalSessionsScreen(
    pty: PtyApi,
    onOpen: (sessionId: String, title: String) -> Unit,
    modifier: Modifier = Modifier,
    viewModelKey: String = "",
) {
    val vm = viewModel(key = "terminal-sessions:$viewModelKey") { TerminalSessionsViewModel(pty) }
    val state by vm.state.collectAsStateWithLifecycle()
    var confirmKill by remember { mutableStateOf<PtySession?>(null) }
    LifecycleResumeEffect(vm) {
        vm.refresh()
        onPauseOrDispose { }
    }
    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            OutlinedButton(onClick = vm::refresh) { Text("Refresh") }
            Button(onClick = { onOpen(PtyIds.newPane(PtyIds.TERMINAL_SURFACE), "Terminal") }) { Text("New terminal") }
        }
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp)) }
        PullToRefreshBox(
            isRefreshing = state.loading,
            onRefresh = vm::refresh,
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) {
            LazyColumn(Modifier.fillMaxSize()) {
                if (!state.loading && state.sessions.isEmpty() && state.error == null) {
                    item { Text("No terminals running.", modifier = Modifier.padding(16.dp)) }
                }
                for ((heading, sessions) in state.sections) {
                    item(key = "heading:$heading") {
                        Text(
                            heading,
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.padding(start = 16.dp, top = 12.dp, bottom = 4.dp),
                        )
                    }
                    items(sessions, key = { it.id }) { session ->
                        SessionRow(session, onOpen = { onOpen(session.id, sessionTitle(session)) }, onKill = { confirmKill = session })
                        HorizontalDivider()
                    }
                }
            }
        }
    }
    confirmKill?.let { session ->
        AlertDialog(
            onDismissRequest = { confirmKill = null },
            title = { Text("End this terminal?") },
            text = { Text("${sessionTitle(session)} will be closed on the server, and anything running in it stops.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmKill = null
                    vm.kill(session.id)
                }) { Text("End") }
            },
            dismissButton = { TextButton(onClick = { confirmKill = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SessionRow(session: PtySession, onOpen: () -> Unit, onKill: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    ListItem(
        headlineContent = { Text(sessionTitle(session), maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = { Text(sessionDetail(session), maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailingContent = {
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("End terminal") }, onClick = {
                        menu = false
                        onKill()
                    })
                }
            }
        },
        modifier = Modifier.clickable(onClick = onOpen),
    )
}

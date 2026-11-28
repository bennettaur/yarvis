package dev.yarvis.android.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mikepenz.markdown.m3.Markdown
import dev.yarvis.android.api.ToolActivity
import dev.yarvis.android.data.ChatTurns
import dev.yarvis.android.data.PendingApproval
import kotlinx.coroutines.delay
import java.time.Instant

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListScreen(
    viewModel: ChatListViewModel,
    onOpen: (sessionId: String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val replying by viewModel.replying.collectAsStateWithLifecycle()
    // Runs each time the list is shown, and when a turn ends, so a new chat's title and time appear.
    LaunchedEffect(replying) { viewModel.refresh() }
    Box(modifier.fillMaxSize()) {
        PullToRefreshBox(isRefreshing = state.loading, onRefresh = viewModel::refresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
                state.error?.let { error ->
                    item { Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
                }
                if (!state.loading && state.error == null && state.sessions.isEmpty()) {
                    item { Text("No chats yet.", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                items(state.sessions, key = { it.id }) { session ->
                    ListItem(
                        headlineContent = { Text(session.title ?: "Untitled chat", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        supportingContent = { Text(relativeTime(session.updatedAt, Instant.now())) },
                        trailingContent = {
                            if (session.id in replying) {
                                Text("Replying…", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                            }
                        },
                        modifier = Modifier.clickable { onOpen(session.id) },
                    )
                    HorizontalDivider()
                }
            }
        }
        ExtendedFloatingActionButton(
            onClick = { onOpen(null) },
            icon = { Icon(Icons.Filled.Add, contentDescription = null) },
            text = { Text("New chat") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }
}

@Composable
fun ChatThreadScreen(viewModel: ChatThreadViewModel, modifier: Modifier = Modifier) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()
    val turn = state.turn
    val pending = state.pendingMessage
    val itemCount = state.messages.size + (if (pending != null) 1 else 0) + (if (turn != null) 1 else 0)
    FollowBottom(listState, itemCount, streamedLength = state.streaming?.length)

    // The parent consumes its own insets, so this is the only place the keyboard is padded for.
    Column(modifier.fillMaxSize().imePadding()) {
        ModelChip(state, viewModel::chooseModel)
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (itemCount == 0 && !state.loading) {
                Text(
                    "Ask Yarvis anything: your PRs, your calendar, what's in a workspace.",
                    modifier = Modifier.align(Alignment.Center).padding(32.dp),
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(state.messages) { message -> MessageBubble(message.role, message.content, message.toolCalls) }
                if (pending != null) item { MessageBubble("user", pending, emptyList()) }
                if (turn != null) {
                    item {
                        if (turn.running) {
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                if (turn.reply.isNotEmpty() || turn.activity.isNotEmpty()) {
                                    MessageBubble("assistant", turn.reply, turn.activity)
                                }
                                WaitingLine(turn)
                            }
                        } else {
                            FailedReply(turn.failure.orEmpty(), onRetry = viewModel::retry)
                        }
                    }
                }
            }
        }
        (state.error ?: state.notice)?.let { text ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text,
                    color = if (state.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = viewModel::dismissMessage) { Text("OK") }
            }
        }
        state.approvals.firstOrNull()?.let { approval ->
            ToolApprovalBar(
                approval = approval,
                waiting = state.approvals.size - 1,
                onAnswer = { approved -> viewModel.answerApproval(approval, approved) },
            )
        }
        Composer(running = state.running, onSend = viewModel::send, onStop = viewModel::stop)
    }
}

/**
 * Keeps the newest item in view, but only while the user is already at the
 * bottom, so reading back up isn't yanked down. Whether they are is decided
 * when a scroll of theirs ends, since growing content alone moves the bottom away.
 */
@Composable
private fun FollowBottom(listState: LazyListState, itemCount: Int, streamedLength: Int?) {
    var follow by remember { mutableStateOf(true) }
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
            if (!scrolling) {
                val layout = listState.layoutInfo
                val last = layout.visibleItemsInfo.lastOrNull()
                follow = isNearBottom(
                    itemCount = layout.totalItemsCount,
                    lastVisibleIndex = last?.index ?: -1,
                    lastItemEnd = last?.let { it.offset + it.size } ?: 0,
                    viewportEnd = layout.viewportEndOffset - layout.afterContentPadding,
                    slack = NEAR_BOTTOM_PX,
                )
            }
        }
    }
    LaunchedEffect(itemCount, streamedLength) {
        if (!follow || itemCount == 0) return@LaunchedEffect
        if (streamedLength != null) {
            // An animation per chunk would stutter, so a streaming reply jumps; scrollBy stops at the end.
            listState.scrollToItem(itemCount - 1)
            listState.scrollBy(PAST_THE_END_PX)
        } else {
            listState.animateScrollToItem(itemCount - 1)
        }
    }
}

private const val NEAR_BOTTOM_PX = 48

// More than any reply is tall; the list stops at its end.
private const val PAST_THE_END_PX = 1_000_000f

/** Shows that a reply is on its way and how long it has taken, so a slow one doesn't look stuck. */
@Composable
private fun WaitingLine(turn: ChatTurns.Turn) {
    val tool = turn.runningTool
    val since = turn.toolStarted.takeIf { tool != null } ?: turn.started
    var seconds by remember(since) { mutableLongStateOf(since.elapsedNow().inWholeSeconds) }
    LaunchedEffect(since) {
        while (true) {
            seconds = since.elapsedNow().inWholeSeconds
            delay(1_000)
        }
    }
    Row(
        Modifier.padding(start = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
        Text(
            waitingLabel(tool?.name, hasText = turn.reply.isNotEmpty(), seconds = seconds),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun FailedReply(message: String, onRetry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
        Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        TextButton(onClick = onRetry) { Text("Retry") }
    }
}

@Composable
private fun ModelChip(state: ThreadState, onChoose: (String, String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val label = state.providers.firstOrNull { it.id == state.provider }?.let { "${it.label} · ${state.model}" } ?: "No model"
    Box(Modifier.padding(horizontal = 12.dp)) {
        AssistChip(
            onClick = { open = true },
            label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            trailingIcon = { Icon(Icons.Filled.ArrowDropDown, contentDescription = null) },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (provider in state.providers.filter { it.available }) {
                for (model in provider.models) {
                    DropdownMenuItem(
                        text = { Text("${provider.label} · ${model.id}") },
                        onClick = {
                            open = false
                            onChoose(provider.id, model.id)
                        },
                    )
                }
            }
        }
    }
}

/** The user's messages are bubbles on the right; replies take the full width, without a card. */
@Composable
private fun MessageBubble(role: String, content: String, toolCalls: List<ToolActivity>) {
    if (role == "user") {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
            Surface(
                shape = RoundedCornerShape(16.dp),
                color = MaterialTheme.colorScheme.primaryContainer,
                modifier = Modifier.widthIn(max = 320.dp),
            ) {
                Text(content, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
            }
        }
    } else {
        Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (toolCalls.isNotEmpty()) ToolActivityList(toolCalls)
            if (content.isNotEmpty()) WebLinksOnly { Markdown(content = content) }
        }
    }
}

/** One compact line per tool call; tapping it shows the result. */
@Composable
private fun ToolActivityList(calls: List<ToolActivity>) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        for (call in calls) {
            var expanded by rememberSaveable(call.id) { mutableStateOf(false) }
            val mark = when (call.status) {
                "ok" -> "✓"
                "error" -> "✗"
                "denied" -> "⊘"
                else -> "…"
            }
            Text(
                "$mark ${call.name}" + (call.durationMs?.let { " · ${it}ms" } ?: ""),
                style = MaterialTheme.typography.labelMedium,
                fontFamily = FontFamily.Monospace,
                modifier = Modifier.clickable { expanded = !expanded },
            )
            if (expanded && call.result != null) {
                Text(call.result, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

@Composable
private fun ToolApprovalBar(approval: PendingApproval, waiting: Int, onAnswer: (Boolean) -> Unit) {
    var expanded by rememberSaveable(approval.id) { mutableStateOf(false) }
    Surface(tonalElevation = 4.dp, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val server = if (approval.server.isNotEmpty()) " on ${approval.server}" else ""
            Text(
                "Allow ${approval.name}$server?" + if (waiting > 0) "  (+$waiting waiting)" else "",
                style = MaterialTheme.typography.titleSmall,
            )
            approval.reason?.let { Text("The assistant says: $it", style = MaterialTheme.typography.bodySmall) }
            // The arguments are always shown: they are what the call will do, and the reason is only the model's claim.
            approval.args?.toString()?.let { args ->
                val long = args.length > ARGS_PREVIEW_CHARS
                Text(
                    if (long && !expanded) args.take(ARGS_PREVIEW_CHARS) + "…" else args,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                )
                if (long) TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Show less" else "Show all") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { onAnswer(true) }) { Text("Approve") }
                OutlinedButton(onClick = { onAnswer(false) }) { Text("Deny") }
            }
        }
    }
}

private const val ARGS_PREVIEW_CHARS = 600

/**
 * Replies are model-written, so their links may open only as web pages, never
 * as another app's deep link or an intent: URI.
 */
@Composable
private fun WebLinksOnly(content: @Composable () -> Unit) {
    val system = LocalUriHandler.current
    val handler = remember(system) {
        object : UriHandler {
            override fun openUri(uri: String) {
                val scheme = uri.substringBefore(':', "").lowercase()
                if (scheme == "https" || scheme == "http") system.openUri(uri)
            }
        }
    }
    CompositionLocalProvider(LocalUriHandler provides handler, content = content)
}


@Composable
private fun Composer(running: Boolean, onSend: (String) -> Unit, onStop: () -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            placeholder = { Text("Message Yarvis") },
            shape = RoundedCornerShape(24.dp),
            modifier = Modifier.weight(1f),
            maxLines = 6,
        )
        if (running) {
            FilledTonalIconButton(onClick = onStop) { Icon(Icons.Filled.Close, contentDescription = "Stop") }
        } else {
            FilledIconButton(
                enabled = text.isNotBlank(),
                onClick = {
                    onSend(text)
                    text = ""
                },
            ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send") }
        }
    }
}

package dev.yarvis.android.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mikepenz.markdown.m3.Markdown
import dev.yarvis.android.api.ToolActivity

@Composable
fun ChatListScreen(
    viewModel: ChatListViewModel,
    onOpen: (sessionId: String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            OutlinedButton(onClick = viewModel::refresh) { Text("Refresh") }
            Button(onClick = { onOpen(null) }) { Text("New chat") }
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp)) }
        LazyColumn {
            items(state.sessions, key = { it.id }) { session ->
                ListItem(
                    headlineContent = { Text(session.title ?: "Untitled chat", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text(session.updatedAt.take(16).replace('T', ' ')) },
                    modifier = Modifier.clickable { onOpen(session.id) },
                )
                HorizontalDivider()
            }
        }
    }
}

@Composable
fun ChatThreadScreen(viewModel: ChatThreadViewModel, modifier: Modifier = Modifier) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()
    val rows = state.messages.size + if (state.running) 1 else 0
    LaunchedEffect(rows, state.streaming?.length) {
        if (rows > 0) listState.scrollToItem(rows - 1)
    }
    Column(modifier.fillMaxSize().imePadding()) {
        ModelPicker(state, viewModel::chooseModel)
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(state.messages) { message -> MessageBubble(message.role, message.content, message.toolCalls) }
            if (state.running) {
                item { MessageBubble("assistant", state.streaming.orEmpty().ifEmpty { "…" }, state.activity) }
            }
        }
        (state.error ?: state.notice)?.let { text ->
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text,
                    color = if (state.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
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

@Composable
private fun ModelPicker(state: ThreadState, onChoose: (String, String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val label = state.providers.firstOrNull { it.id == state.provider }?.let { "${it.label} · ${state.model}" } ?: "No model"
    Box(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
        TextButton(onClick = { open = true }) { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) }
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

@Composable
private fun MessageBubble(role: String, content: String, toolCalls: List<ToolActivity>) {
    val mine = role == "user"
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Card(
            colors = CardDefaults.cardColors(
                containerColor = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            ),
            modifier = Modifier.fillMaxWidth(if (mine) 0.85f else 1f),
        ) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (toolCalls.isNotEmpty()) ToolActivityList(toolCalls)
                if (mine) Text(content) else WebLinksOnly { Markdown(content = content) }
            }
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
    Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            placeholder = { Text("Message Yarvis") },
            modifier = Modifier.weight(1f),
            maxLines = 6,
        )
        Spacer(Modifier.width(8.dp))
        if (running) {
            OutlinedButton(onClick = onStop) { Text("Stop") }
        } else {
            Button(
                enabled = text.isNotBlank(),
                onClick = {
                    onSend(text)
                    text = ""
                },
            ) { Text("Send") }
        }
    }
}

package dev.yarvis.android.ui.attention

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.yarvis.android.api.AgentQuestion
import dev.yarvis.android.api.AttentionItem
import dev.yarvis.android.api.HeadsDownAnswer
import dev.yarvis.android.api.HeadsDownQuestion
import dev.yarvis.android.api.PermissionDecision
import dev.yarvis.android.api.PermissionRequest
import dev.yarvis.android.api.QuestionAnswer
import dev.yarvis.android.api.QuestionItem
import dev.yarvis.android.api.ServerApproval
import dev.yarvis.android.api.YarvisJson
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

@Composable
fun AttentionScreen(viewModel: AttentionViewModel, modifier: Modifier = Modifier) {
    val attention by viewModel.attention.collectAsStateWithLifecycle()
    val opened by viewModel.opened.collectAsStateWithLifecycle()
    val message by viewModel.message.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()

    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                attention.error?.let { "Reconnecting… ($it)" } ?: "Live",
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.weight(1f),
            )
            OutlinedButton(onClick = viewModel::refresh) { Text("Refresh") }
        }
        message?.let {
            Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(it, modifier = Modifier.weight(1f))
                TextButton(onClick = viewModel::dismissMessage) { Text("OK") }
            }
        }
        if (attention.loaded && attention.items.isEmpty() && attention.approvals.isEmpty()) {
            Text("Nothing needs you right now.", modifier = Modifier.padding(24.dp))
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(attention.approvals, key = { "approval:${it.id}" }) { approval ->
                ServerApprovalRow(approval, busy) { approve -> viewModel.answerApproval(approval, approve) }
                HorizontalDivider()
            }
            items(attention.items, key = { it.id }) { item ->
                ListItem(
                    overlineContent = { Text(kindLabel(item)) },
                    headlineContent = { Text(item.title) },
                    supportingContent = item.body?.let { body -> { Text(body, maxLines = 3) } },
                    trailingContent = { TextButton(onClick = { viewModel.dismiss(item) }) { Text("Dismiss") } },
                    modifier = Modifier.clickable { viewModel.openItem(item) },
                )
                HorizontalDivider()
            }
        }
    }

    opened?.let { ItemSheet(it, busy, viewModel) }
}

private fun kindLabel(item: AttentionItem): String = when {
    item.isClaudePermission -> "Permission prompt"
    item.kind == "question" -> "Question"
    item.headsDownQuestionId != null -> if (item.kind == "permission") "Heads-down approval" else "Heads-down question"
    else -> item.kind.replaceFirstChar { it.uppercase() }
}

@Composable
private fun ServerApprovalRow(approval: ServerApproval, busy: Boolean, onAnswer: (Boolean) -> Unit) {
    Card(Modifier.fillMaxWidth().padding(12.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Server approval · ${approval.kind}", style = MaterialTheme.typography.labelMedium)
            Text(approval.summary, style = MaterialTheme.typography.bodyLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(enabled = !busy, onClick = { onAnswer(true) }) { Text("Approve") }
                OutlinedButton(enabled = !busy, onClick = { onAnswer(false) }) { Text("Deny") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ItemSheet(open: OpenItem, busy: Boolean, viewModel: AttentionViewModel) {
    ModalBottomSheet(onDismissRequest = viewModel::close) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(open.item.title, style = MaterialTheme.typography.titleMedium)
            open.item.body?.let { Text(it) }
            when (val detail = open.detail) {
                ItemDetail.Loading -> CircularProgressIndicator()
                is ItemDetail.Failed -> Text(detail.message, color = MaterialTheme.colorScheme.error)
                is ItemDetail.Permissions -> {
                    if (detail.requests.isEmpty()) Text("This prompt was already answered.")
                    detail.requests.forEach { PermissionCard(it, busy, viewModel) }
                }
                is ItemDetail.Questions -> {
                    if (detail.questions.isEmpty()) Text("This question was already answered.")
                    detail.questions.forEach { question ->
                        QuestionForm(
                            questions = question.questions,
                            busy = busy,
                            onSubmit = { answers -> viewModel.answerQuestion(question, answers) },
                            onDecline = { viewModel.declineQuestion(question) },
                            header = { QuestionContextText(question) },
                        )
                    }
                }
                is ItemDetail.HeadsDown -> detail.question?.let { HeadsDownForm(it, busy, viewModel) }
                    ?: Text("This question was already answered.")
                ItemDetail.Info -> TextButton(onClick = { viewModel.markRead(open.item) }) { Text("Mark read") }
            }
            OutlinedButton(enabled = !busy, onClick = { viewModel.dismiss(open.item) }) { Text("Dismiss from the list") }
        }
    }
}

@Composable
private fun QuestionContextText(question: AgentQuestion) {
    Text(question.context.task, style = MaterialTheme.typography.bodyMedium)
    question.context.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
}

@Composable
private fun PermissionCard(request: PermissionRequest, busy: Boolean, viewModel: AttentionViewModel) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                listOfNotNull(request.workspaceName, request.toolName).joinToString(" · "),
                style = MaterialTheme.typography.titleSmall,
            )
            val asked = askedQuestions(request)
            if (asked != null) {
                QuestionForm(
                    questions = asked,
                    busy = busy,
                    onSubmit = { answers ->
                        viewModel.decidePermission(request, PermissionDecision.Answer(permissionAnswers(asked, answers)))
                    },
                    onDecline = { viewModel.decidePermission(request, PermissionDecision.Deny()) },
                )
            } else {
                Text(formatToolInput(request), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                var message by remember(request.id) { mutableStateOf("") }
                OutlinedTextField(
                    value = message,
                    onValueChange = { message = it },
                    label = { Text("Reason, if you deny (optional)") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(enabled = !busy, onClick = { viewModel.decidePermission(request, PermissionDecision.Allow) }) {
                        Text("Allow")
                    }
                    OutlinedButton(
                        enabled = !busy,
                        onClick = { viewModel.decidePermission(request, PermissionDecision.Deny(message.trim().ifEmpty { null })) },
                    ) { Text("Deny") }
                }
            }
        }
    }
}

/** Claude Code's AskUserQuestion prompt carries its questions in `toolInput.questions`. */
private fun askedQuestions(request: PermissionRequest): List<QuestionItem>? {
    if (request.toolName != "AskUserQuestion") return null
    val raw = request.toolInput["questions"] as? JsonArray ?: return null
    return runCatching { YarvisJson.decodeFromJsonElement(ListSerializer(QuestionItem.serializer()), raw) }.getOrNull()
}

/** One string per question text, picks joined as the web joins them. */
internal fun permissionAnswers(questions: List<QuestionItem>, answers: List<QuestionAnswer>): Map<String, String> =
    questions.zip(answers).associate { (q, a) ->
        q.question to listOf(a.selected.joinToString(", "), a.text.orEmpty().trim()).filter { it.isNotEmpty() }.joinToString("\n")
    }

private fun formatToolInput(request: PermissionRequest): String {
    val command = (request.toolInput["command"] as? JsonPrimitive)?.contentOrNull
    if (command != null) return command
    return request.toolInput.entries.joinToString("\n") { (name, value) -> "$name: ${compact(value)}" }
}

private fun compact(value: JsonElement): String =
    ((value as? JsonPrimitive)?.contentOrNull ?: value.toString()).let { if (it.length > 600) it.take(600) + "…" else it }

/**
 * A form for one to four questions, each with options (one or several) and a
 * free-text field. Each question needs a pick or some text before it can be sent.
 */
@Composable
private fun QuestionForm(
    questions: List<QuestionItem>,
    busy: Boolean,
    onSubmit: (List<QuestionAnswer>) -> Unit,
    onDecline: () -> Unit,
    header: @Composable () -> Unit = {},
) {
    val selected = remember(questions) { questions.map { mutableStateListOf<String>() } }
    val texts = remember(questions) { mutableStateListOf(*Array(questions.size) { "" }) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        header()
        questions.forEachIndexed { i, q ->
            q.header?.let { Text(it, style = MaterialTheme.typography.labelMedium) }
            Text(q.question, style = MaterialTheme.typography.bodyLarge)
            q.options?.let { options ->
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    options.forEach { option ->
                        val isSelected = option.label in selected[i]
                        if (q.multiSelect) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Checkbox(checked = isSelected, onCheckedChange = { if (it) selected[i].add(option.label) else selected[i].remove(option.label) })
                                Text(option.label)
                            }
                        } else {
                            FilterChip(
                                selected = isSelected,
                                onClick = {
                                    selected[i].clear()
                                    if (!isSelected) selected[i].add(option.label)
                                },
                                label = { Text(option.label) },
                            )
                        }
                    }
                }
                options.firstOrNull { it.label in selected[i] }?.description?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall)
                }
            }
            OutlinedTextField(
                value = texts[i],
                onValueChange = { texts[i] = it },
                label = { Text(if (q.options.isNullOrEmpty()) "Your answer" else "Add a note (optional)") },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        val ready = questions.indices.all { selected[it].isNotEmpty() || texts[it].isNotBlank() }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                enabled = ready && !busy,
                onClick = {
                    onSubmit(questions.indices.map { QuestionAnswer(selected[it].toList(), texts[it].trim().ifEmpty { null }) })
                },
            ) { Text("Send answer") }
            OutlinedButton(enabled = !busy, onClick = onDecline) { Text("Decline") }
        }
    }
}

@Composable
private fun HeadsDownForm(question: HeadsDownQuestion, busy: Boolean, viewModel: AttentionViewModel) {
    var text by remember(question.id) { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        question.situation?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        Text(question.question, style = MaterialTheme.typography.bodyLarge)
        question.action?.let { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
        if (question.options.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                question.options.forEach { option ->
                    Button(enabled = !busy, onClick = { viewModel.answerHeadsDown(question, HeadsDownAnswer(choice = option)) }) {
                        Text(option.replaceFirstChar { it.uppercase() })
                    }
                }
            }
        }
        if (question.kind == "question") {
            OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text("Your answer") }, modifier = Modifier.fillMaxWidth())
            Button(enabled = text.isNotBlank() && !busy, onClick = { viewModel.answerHeadsDown(question, HeadsDownAnswer(answer = text.trim())) }) {
                Text("Send answer")
            }
        }
        TextButton(enabled = !busy, onClick = { viewModel.dismissHeadsDown(question) }) { Text("Dismiss the question") }
    }
}

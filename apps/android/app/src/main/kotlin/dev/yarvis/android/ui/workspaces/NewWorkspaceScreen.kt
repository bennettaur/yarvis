package dev.yarvis.android.ui.workspaces

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.yarvis.android.api.WorkspaceSummary

@Composable
fun NewWorkspaceScreen(
    viewModel: NewWorkspaceViewModel,
    onCreated: (WorkspaceSummary) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(state.created) { state.created?.let(onCreated) }
    Column(
        modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        OutlinedTextField(
            value = state.name,
            onValueChange = viewModel::setName,
            label = { Text("Name") },
            placeholder = { Text("rename the API") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            modifier = Modifier.fillMaxWidth(),
        )
        Text("Repos (optional)", style = MaterialTheme.typography.labelMedium)
        val reposError = state.reposError
        when {
            state.reposLoading -> LinearProgressIndicator(Modifier.fillMaxWidth())
            reposError != null -> Text(reposError, color = MaterialTheme.colorScheme.error)
            state.repos.isEmpty() -> Text(
                "No repos registered. Add one in Settings → Repositories.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        for (repo in state.repos) {
            val ticked = repo.id in state.ticked
            Column {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clickable { viewModel.toggle(repo.id) }) {
                    Checkbox(checked = ticked, onCheckedChange = null)
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        Text(repo.name)
                        Text(repo.fullName, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (ticked) {
                    BranchChoice(
                        branches = state.branches[repo.id],
                        chosen = state.chosenBranch[repo.id],
                        onChoose = { viewModel.chooseBranch(repo.id, it) },
                        onRetry = { viewModel.loadBranches(repo.id) },
                    )
                }
            }
        }
        Text(
            "Leave empty for a scratch workspace — just a folder to run an agent in, for experimentation and exploration.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (state.tasks.isNotEmpty()) TaskChoice(state, viewModel::setTask)
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onCancel) { Text("Cancel") }
            Button(onClick = viewModel::create, enabled = !state.busy) { Text(if (state.busy) "Creating…" else "Create") }
        }
    }
}

@Composable
private fun TaskChoice(state: NewWorkspaceState, onChoose: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Link a task (optional)", style = MaterialTheme.typography.labelMedium)
        Box {
            OutlinedButton(onClick = { open = true }) {
                Text(state.tasks.firstOrNull { it.id == state.taskId }?.title ?: "None", maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                DropdownMenuItem(text = { Text("None") }, onClick = {
                    open = false
                    onChoose(null)
                })
                for (task in state.tasks) {
                    DropdownMenuItem(text = { Text(task.title) }, onClick = {
                        open = false
                        onChoose(task.id)
                    })
                }
            }
        }
        Text("Archiving the workspace will mark a linked task done.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A repo's branch: a new one by default, or an existing remote branch picked from a searchable list. */
@Composable
private fun BranchChoice(branches: Branches?, chosen: String?, onChoose: (String?) -> Unit, onRetry: () -> Unit) {
    var picking by rememberSaveable { mutableStateOf(false) }
    Row(Modifier.padding(start = 40.dp), verticalAlignment = Alignment.CenterVertically) {
        when (branches) {
            is Branches.Loaded -> TextButton(onClick = { picking = true }) { Text(chosen ?: "New branch", maxLines = 1, overflow = TextOverflow.Ellipsis) }
            is Branches.Failed -> {
                Text(branches.message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                TextButton(onClick = onRetry) { Text("Retry") }
            }
            Branches.Loading, null -> Text("Loading branches…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (picking && branches is Branches.Loaded) {
        BranchPickerDialog(
            branches.names,
            onChoose = {
                picking = false
                onChoose(it)
            },
            onDismiss = { picking = false },
        )
    }
}

@Composable
private fun BranchPickerDialog(branches: List<String>, onChoose: (String?) -> Unit, onDismiss: () -> Unit) {
    var filter by rememberSaveable { mutableStateOf("") }
    val shown = if (filter.isBlank()) branches else branches.filter { it.contains(filter.trim(), ignoreCase = true) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Branch") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = filter,
                    onValueChange = { filter = it },
                    placeholder = { Text("Filter branches") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                LazyColumn(Modifier.heightIn(max = 360.dp)) {
                    item { BranchOption("New branch") { onChoose(null) } }
                    items(shown) { name -> BranchOption(name) { onChoose(name) } }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun BranchOption(label: String, onClick: () -> Unit) {
    Text(
        label,
        fontFamily = FontFamily.Monospace,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp),
    )
}

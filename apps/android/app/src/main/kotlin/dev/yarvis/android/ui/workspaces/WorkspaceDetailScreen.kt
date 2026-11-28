package dev.yarvis.android.ui.workspaces

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.yarvis.android.api.PtySession
import dev.yarvis.android.api.WorkspaceDetail
import dev.yarvis.android.api.WorkspaceRepoDetail
import dev.yarvis.android.api.WorkspaceRepoPr

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceDetailScreen(
    viewModel: WorkspaceDetailViewModel,
    onOpenTerminal: (TerminalTarget) -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val pendingOpen by viewModel.pendingOpen.collectAsStateWithLifecycle()
    LifecycleResumeEffect(viewModel) {
        viewModel.resume()
        onPauseOrDispose { viewModel.pause() }
    }
    LaunchedEffect(pendingOpen) {
        pendingOpen?.let {
            viewModel.opened()
            onOpenTerminal(it)
        }
    }
    val detail = state.detail

    PullToRefreshBox(isRefreshing = false, onRefresh = viewModel::refresh, modifier = modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            state.loadError?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp)) } }
            state.message?.let { message ->
                item {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                        TextButton(onClick = viewModel::dismissMessage) { Text("OK") }
                    }
                }
            }
            if (detail != null) {
                item {
                    Header(
                        detail,
                        state,
                        onArchive = viewModel::openArchive,
                        onProvision = viewModel::provision,
                        onIgnoreError = viewModel::ignoreError,
                    )
                }
                state.provisionLog?.let { log -> item { ProvisionLog(log, state.provisioning, viewModel::closeProvisionLog) } }
                if (detail.status == "archived") {
                    item { ArchivedSummary(detail) }
                } else {
                    item {
                        AgentSection(
                            state,
                            onPickHarness = viewModel::pickHarness,
                            onOpenOrStart = viewModel::openOrStartAgent,
                            onStop = viewModel::stopAgent,
                        )
                    }
                    item {
                        ShellsSection(
                            state,
                            onOpenShell = { shell -> viewModel.shellTarget(shell)?.let(onOpenTerminal) },
                            onNewShell = { viewModel.newShell()?.let(onOpenTerminal) },
                        )
                    }
                }
                if (detail.repos.isNotEmpty()) item { SectionLabel("Repos") }
                items(detail.repos, key = { it.id }) { repo -> RepoCard(repo) }
                if (detail.tasks.isNotEmpty() || detail.issues.isNotEmpty()) {
                    item { LinkedWork(detail) }
                }
            }
        }
    }
    if (state.archiveDialogOpen && detail != null) {
        ArchiveDialog(
            detail = detail,
            busy = state.busy,
            message = state.archiveError,
            onArchive = viewModel::archive,
            onDismiss = viewModel::closeArchive,
        )
    }
}

@Composable
private fun Header(
    detail: WorkspaceDetail,
    state: WorkspaceDetailState,
    onArchive: () -> Unit,
    onProvision: () -> Unit,
    onIgnoreError: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusChip(detail.status)
            Spacer(Modifier.width(8.dp))
            Text(
                workspaceStatusHelp(detail.status),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            if (detail.status != "archived") {
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem(
                            text = { Text(archiveButtonLabel(detail)) },
                            enabled = !detail.isTearingDown && !state.busy,
                            onClick = {
                                menu = false
                                onArchive()
                            },
                        )
                    }
                }
            }
        }
        val blocked = archiveBlockedText(detail)
        val error = blocked ?: detail.error
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        val actions = provisionActions(detail)
        if (actions.show && state.provisionLog == null) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onProvision, enabled = !state.provisioning) { Text(actions.label) }
                if (actions.showIgnore) {
                    OutlinedButton(onClick = onIgnoreError, enabled = !state.busy) { Text("Ignore and use anyway") }
                }
            }
        }
    }
}

@Composable
private fun ProvisionLog(log: String, running: Boolean, onClose: () -> Unit) {
    Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (running) "Provisioning…" else "Provision log", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                if (!running) TextButton(onClick = onClose) { Text("Close") }
            }
            if (running) LinearProgressIndicator(Modifier.fillMaxWidth())
            val scroll = rememberScrollState()
            // Follows the tail as lines arrive, like a terminal.
            LaunchedEffect(log.length) { scroll.scrollTo(scroll.maxValue) }
            Box(Modifier.heightIn(max = 320.dp).verticalScroll(scroll)) {
                Text(
                    log.ifEmpty { "Starting…" },
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                )
            }
        }
    }
}

@Composable
private fun ArchivedSummary(detail: WorkspaceDetail) {
    val context = LocalContext.current
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        detail.archivedAt?.let { Text("Archived ${it.take(16).replace('T', ' ')}", style = MaterialTheme.typography.bodySmall) }
        detail.summary?.takeIf { it.isNotBlank() }?.let { Text(it) }
        detail.mergedPrUrl?.takeIf { it.isNotBlank() }?.let { url ->
            TextButton(onClick = { openUrl(context, url) }) { Text(url, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}

@Composable
private fun AgentSection(
    state: WorkspaceDetailState,
    onPickHarness: (String) -> Unit,
    onOpenOrStart: () -> Unit,
    onStop: () -> Unit,
) {
    val detail = state.detail ?: return
    // The agent starts in the workspace's folder, which exists once it is active.
    if (detail.status != "active" && !state.agentRunning) return
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionLabel("Agent")
        Text(
            if (state.agentRunning) "${state.agentName} is running." else "No agent session is running.",
            style = MaterialTheme.typography.bodyMedium,
        )
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (state.showsHarnessPicker) HarnessPicker(state, onPickHarness)
            Button(onClick = onOpenOrStart, enabled = !state.agentBusy) {
                Text(if (state.agentRunning) "Open agent" else "Start ${state.agentName} session")
            }
            if (state.agentRunning) {
                OutlinedButton(onClick = onStop, enabled = !state.agentBusy) { Text("Stop agent") }
            }
        }
    }
}

@Composable
private fun HarnessPicker(state: WorkspaceDetailState, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }) { Text(state.agentName) }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (harness in state.agentConfig.harnesses) {
                DropdownMenuItem(
                    text = { Text(harness.name) },
                    onClick = {
                        open = false
                        onPick(harness.id)
                    },
                )
            }
        }
    }
}

@Composable
private fun ShellsSection(state: WorkspaceDetailState, onOpenShell: (PtySession) -> Unit, onNewShell: () -> Unit) {
    val detail = state.detail ?: return
    if (detail.status != "active" && state.shells.isEmpty()) return
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionLabel("Shells")
        for ((index, shell) in state.shells.withIndex()) {
            ShellRow(index + 1, shell, onClick = { onOpenShell(shell) })
        }
        if (detail.status == "active") {
            OutlinedButton(onClick = onNewShell) { Text("New shell") }
        }
    }
}

@Composable
private fun ShellRow(number: Int, shell: PtySession, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text("Shell $number") },
        supportingContent = {
            val status = if (shell.running) "running" else ("exited" + (shell.exitCode?.let { " ($it)" } ?: ""))
            Text(listOfNotNull(status, shell.cwd).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis)
        },
        modifier = Modifier.clickable(onClick = onClick),
    )
}

@Composable
private fun RepoCard(repo: WorkspaceRepoDetail) {
    Card(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(repo.repo.name, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                StatusChip(repo.status)
            }
            Text(
                repo.branch + (repo.baseBranch?.let { " ← $it" } ?: ""),
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall,
            )
            repo.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            if (repo.prs.isEmpty()) {
                Text(noPrLabel(repo), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            repo.prsPollError?.let {
                Text("Couldn't search for PRs: $it", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            for (pr in repo.prs) PrRow(repo, pr)
        }
    }
}

@Composable
private fun PrRow(repo: WorkspaceRepoDetail, pr: WorkspaceRepoPr) {
    val number = pr.prNumber ?: return
    val context = LocalContext.current
    val url = pr.prUrl
    val glance = prGlance(pr)
    Column(
        Modifier.fillMaxWidth()
            .then(if (url != null) Modifier.clickable { openUrl(context, url) } else Modifier)
            .padding(vertical = 4.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(glance.icon, color = glanceColor(glance))
            Text("#$number", fontFamily = FontFamily.Monospace)
            Text(pr.prState ?: "open", style = MaterialTheme.typography.labelMedium)
            if (pr.isDraft == true) Text("draft", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            // Named only when it isn't the worktree's own branch, such as a stack layer.
            pr.headBranch?.takeIf { it != repo.branch }?.let {
                Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        val details = listOfNotNull(
            checksLabel(pr.checkRollup) + (checkCountsLabel(pr)?.let { " ($it)" } ?: ""),
            reviewDecisionLabel(pr.reviewDecision),
            if (hasConflicts(pr.mergeable)) "⚠ merge conflicts" else null,
        )
        Text(details.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        pr.lastError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun LinkedWork(detail: WorkspaceDetail) {
    val context = LocalContext.current
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (detail.tasks.isNotEmpty()) {
            SectionLabel("Tasks")
            for (task in detail.tasks) {
                Text((if (task.status == "done") "✓ " else "○ ") + task.title, style = MaterialTheme.typography.bodyMedium)
            }
        }
        if (detail.issues.isNotEmpty()) {
            SectionLabel("Issues")
            for (issue in detail.issues) {
                val url = issue.url
                Text(
                    issueLinkLabel(issue) + (issue.title?.let { " $it" } ?: ""),
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = if (url != null) Modifier.clickable { openUrl(context, url) }.padding(vertical = 2.dp) else Modifier,
                )
            }
        }
    }
}

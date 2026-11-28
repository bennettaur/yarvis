package dev.yarvis.android.ui.workspaces

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.yarvis.android.api.ArchiveRequest
import dev.yarvis.android.api.PtySession
import dev.yarvis.android.api.WorkspaceDetail
import dev.yarvis.android.api.WorkspaceRepoDetail
import dev.yarvis.android.api.WorkspaceRepoPr
import dev.yarvis.android.api.WorkspaceSummary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceListScreen(
    viewModel: WorkspaceListViewModel,
    onOpen: (WorkspaceSummary) -> Unit,
    onNew: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LifecycleResumeEffect(viewModel) {
        viewModel.resume()
        onPauseOrDispose { viewModel.pause() }
    }
    Box(modifier.fillMaxSize()) {
        PullToRefreshBox(
            isRefreshing = state.refreshing && !state.loading,
            onRefresh = viewModel::refresh,
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 88.dp)) {
                if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                state.error?.let { error ->
                    item { Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp)) }
                }
                if (!state.loading && state.groups.isEmpty()) {
                    item {
                        Text(
                            if (state.showArchived || state.archivedCount == 0) "No workspaces yet." else "No active workspaces.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(16.dp),
                        )
                    }
                }
                for (group in state.groups) {
                    item(key = "group:${group.label}") {
                        Text(
                            group.label,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
                        )
                    }
                    items(group.workspaces, key = { it.id }) { ws -> WorkspaceRow(ws, onClick = { onOpen(ws) }) }
                }
                if (state.archivedCount > 0) {
                    item(key = "archived") {
                        TextButton(onClick = viewModel::toggleArchived, modifier = Modifier.padding(8.dp)) {
                            Text(if (state.showArchived) "Hide archived" else "Show archived (${state.archivedCount})")
                        }
                    }
                }
            }
        }
        ExtendedFloatingActionButton(
            onClick = onNew,
            icon = { Icon(Icons.Filled.Add, contentDescription = null) },
            text = { Text("New workspace") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }
}

@Composable
private fun WorkspaceRow(ws: WorkspaceSummary, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(ws.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = if (ws.repoNames.size > 1 || ws.error != null) {
            {
                Column {
                    if (ws.repoNames.size > 1) Text(ws.repoNames.joinToString(", "), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    ws.error?.let { Text(it, color = MaterialTheme.colorScheme.error, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            }
        } else {
            null
        },
        trailingContent = {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                PrBadges(ws)
                StatusChip(ws.status)
            }
        },
        modifier = Modifier.clickable(onClick = onClick),
    )
    HorizontalDivider()
}

/** One glyph per PR, so one failing repo of several still shows. */
@Composable
private fun PrBadges(ws: WorkspaceSummary) {
    Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        for (pr in ws.prs) {
            val glance = prGlance(pr)
            Text(
                glance.icon,
                color = glanceColor(glance),
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier.semantics { contentDescription = prGlanceDescription(pr) },
            )
        }
    }
}

@Composable
private fun glanceColor(glance: PrGlance): Color = when (glance) {
    PrGlance.Merged -> Color(0xFF8E6BD8)
    PrGlance.Conflicts, PrGlance.ChecksFailing -> MaterialTheme.colorScheme.error
    PrGlance.ChangesRequested, PrGlance.ChecksRunning -> Color(0xFFC08A00)
    PrGlance.ReadyToMerge, PrGlance.Approved -> Color(0xFF2E9D57)
    PrGlance.Closed, PrGlance.Draft, PrGlance.Open -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
private fun StatusChip(status: String) {
    val colors = MaterialTheme.colorScheme
    val (background, foreground) = when (status) {
        "active", "ready" -> colors.primaryContainer to colors.onPrimaryContainer
        "error" -> colors.errorContainer to colors.onErrorContainer
        "creating", "archiving", "provisioning" -> colors.tertiaryContainer to colors.onTertiaryContainer
        else -> colors.surfaceVariant to colors.onSurfaceVariant
    }
    Surface(color = background, contentColor = foreground, shape = MaterialTheme.shapes.small) {
        Text(status, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
    }
}

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
    var archiving by rememberSaveable { mutableStateOf(false) }
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
                item { Header(detail, state, viewModel, onArchive = { archiving = true }) }
                state.provisionLog?.let { log -> item { ProvisionLog(log, state.provisioning, viewModel::closeProvisionLog) } }
                if (detail.status == "archived") {
                    item { ArchivedSummary(detail) }
                } else {
                    item { AgentSection(state, viewModel) }
                    item { ShellsSection(state, viewModel, onOpenTerminal) }
                }
                if (detail.repos.isNotEmpty()) item { SectionLabel("Repos") }
                items(detail.repos, key = { it.id }) { repo -> RepoCard(repo) }
                if (detail.tasks.isNotEmpty() || detail.issues.isNotEmpty()) {
                    item { LinkedWork(detail) }
                }
            }
        }
    }
    if (archiving && detail != null) {
        ArchiveDialog(
            detail = detail,
            busy = state.busy,
            message = state.message,
            onArchive = { request -> viewModel.archive(request, onStarted = { archiving = false }) },
            onDismiss = { archiving = false },
        )
    }
}

@Composable
private fun Header(detail: WorkspaceDetail, state: WorkspaceDetailState, viewModel: WorkspaceDetailViewModel, onArchive: () -> Unit) {
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
                Button(onClick = viewModel::provision, enabled = !state.provisioning) { Text(actions.label) }
                if (actions.showIgnore) {
                    OutlinedButton(onClick = viewModel::ignoreError, enabled = !state.busy) { Text("Ignore and use anyway") }
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
private fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp),
    )
}

@Composable
private fun AgentSection(state: WorkspaceDetailState, viewModel: WorkspaceDetailViewModel) {
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
            if (state.showsHarnessPicker) HarnessPicker(state, viewModel::pickHarness)
            Button(onClick = viewModel::openOrStartAgent, enabled = !state.agentBusy) {
                Text(if (state.agentRunning) "Open agent" else "Start ${state.agentName} session")
            }
            if (state.agentRunning) {
                OutlinedButton(onClick = viewModel::stopAgent, enabled = !state.agentBusy) { Text("Stop agent") }
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
private fun ShellsSection(state: WorkspaceDetailState, viewModel: WorkspaceDetailViewModel, onOpen: (TerminalTarget) -> Unit) {
    val detail = state.detail ?: return
    if (detail.status != "active" && state.shells.isEmpty()) return
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionLabel("Shells")
        for ((index, shell) in state.shells.withIndex()) {
            ShellRow(index + 1, shell, onClick = { viewModel.shellTarget(shell)?.let(onOpen) })
        }
        if (detail.status == "active") {
            OutlinedButton(onClick = { viewModel.newShell()?.let(onOpen) }) { Text("New shell") }
        }
    }
}

@Composable
private fun ShellRow(number: Int, shell: PtySession, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text("Shell $number") },
        supportingContent = {
            val status = if (shell.running) "running" else "exited" + (shell.exitCode?.let { " ($it)" } ?: "")
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

/**
 * The web's archive form. Force remove replaces Archive once a teardown
 * stopped on a worktree with uncommitted or unpushed work.
 */
@Composable
private fun ArchiveDialog(
    detail: WorkspaceDetail,
    busy: Boolean,
    message: String?,
    onArchive: (ArchiveRequest) -> Unit,
    onDismiss: () -> Unit,
) {
    var summary by rememberSaveable(detail.id) { mutableStateOf(detail.summary.orEmpty()) }
    var prUrl by rememberSaveable(detail.id) { mutableStateOf(archivePrefillPrUrl(detail)) }
    // Tracks the unticked ones, so an issue linked while the dialog is open starts ticked.
    var keepOpen by rememberSaveable(detail.id) { mutableStateOf(emptyList<String>()) }
    val unfinished = unfinishedIssues(detail)
    val blocked = archiveBlockedText(detail)
    fun submit(force: Boolean) = onArchive(
        ArchiveRequest(
            summary = summary.trim().ifEmpty { null },
            mergedPrUrl = prUrl.trim().ifEmpty { null },
            force = force,
            closeIssueIds = unfinished.map { it.id }.filterNot { it in keepOpen },
        ),
    )
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Archive “${detail.name}”") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(archiveDescription(detail), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(
                    value = summary,
                    onValueChange = { summary = it },
                    label = { Text("Summary") },
                    placeholder = { Text("What was done to complete the task") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = prUrl,
                    onValueChange = { prUrl = it },
                    label = { Text("PR URL") },
                    placeholder = { Text("https://github.com/owner/repo/pull/123") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (unfinished.isNotEmpty()) {
                    Text("Close linked issues", style = MaterialTheme.typography.labelMedium)
                    for (issue in unfinished) {
                        val ticked = issue.id !in keepOpen
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth().clickable(enabled = !busy) {
                                keepOpen = if (ticked) keepOpen + issue.id else keepOpen - issue.id
                            },
                        ) {
                            Checkbox(checked = ticked, onCheckedChange = null, enabled = !busy)
                            Spacer(Modifier.width(8.dp))
                            Text("${issueLinkLabel(issue)} ${issue.title.orEmpty()}", maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                blocked?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                message?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            if (blocked != null) {
                TextButton(onClick = { submit(force = true) }, enabled = !busy) {
                    Text("Force remove", color = MaterialTheme.colorScheme.error)
                }
            } else {
                TextButton(onClick = { submit(force = false) }, enabled = !busy) { Text(if (busy) "Archiving…" else "Archive") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") } },
    )
}

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
        when {
            state.reposLoading -> LinearProgressIndicator(Modifier.fillMaxWidth())
            state.reposError != null -> Text(state.reposError!!, color = MaterialTheme.colorScheme.error)
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

/** Opens a PR or issue in the browser. Only web links: these URLs come from a provider. */
private fun openUrl(context: Context, url: String) {
    val uri = url.toUri()
    if (uri.scheme != "https" && uri.scheme != "http") return
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri))
    } catch (_: ActivityNotFoundException) {
        // No browser to hand it to; nothing else to do with it.
    }
}

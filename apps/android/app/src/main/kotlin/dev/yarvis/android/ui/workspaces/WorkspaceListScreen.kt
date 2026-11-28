package dev.yarvis.android.ui.workspaces

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
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

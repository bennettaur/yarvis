package dev.yarvis.android.ui.workspaces

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.yarvis.android.api.ArchiveRequest
import dev.yarvis.android.api.WorkspaceDetail

/**
 * The web's archive form. Force remove replaces Archive once a teardown
 * stopped on a worktree with uncommitted or unpushed work.
 */
@Composable
internal fun ArchiveDialog(
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

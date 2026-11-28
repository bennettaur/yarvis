package dev.yarvis.android.ui.workspaces

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri

@Composable
internal fun glanceColor(glance: PrGlance): Color = when (glance) {
    PrGlance.Merged -> Color(0xFF8E6BD8)
    PrGlance.Conflicts, PrGlance.ChecksFailing -> MaterialTheme.colorScheme.error
    PrGlance.ChangesRequested, PrGlance.ChecksRunning -> Color(0xFFC08A00)
    PrGlance.ReadyToMerge, PrGlance.Approved -> Color(0xFF2E9D57)
    PrGlance.Closed, PrGlance.Draft, PrGlance.Open -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
internal fun StatusChip(status: String) {
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

@Composable
internal fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp),
    )
}

/** Opens a PR or issue in the browser. Only web links: these URLs come from a provider. */
internal fun openUrl(context: Context, url: String) {
    val uri = url.toUri()
    if (uri.scheme != "https" && uri.scheme != "http") return
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
    } catch (_: ActivityNotFoundException) {
        // No browser to hand it to; nothing else to do with it.
    }
}

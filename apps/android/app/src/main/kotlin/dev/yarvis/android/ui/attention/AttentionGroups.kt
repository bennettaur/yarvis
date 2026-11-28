package dev.yarvis.android.ui.attention

import dev.yarvis.android.api.AttentionItem
import dev.yarvis.android.api.AttentionNavTarget
import dev.yarvis.android.api.PtyIds

// The bell's grouping and opening rules, as the web has them
// (`src/lib/attentionGroups.ts`, `openAttentionItem` in `src/App.tsx`).

/** The categories in the order the list shows them: review work first. */
val ATTENTION_CATEGORIES = listOf("review", "build", "slack", "general")

fun categoryLabel(category: String): String = when (category) {
    "review" -> "Review"
    "build" -> "Build"
    "slack" -> "Slack"
    else -> "General"
}

/** What a group's clear covers, matching how it was grouped. Both null for a single item with no origin. */
data class AttentionScope(val workspaceId: String? = null, val sessionKey: String? = null)

data class AttentionGroup(
    val key: String,
    /** Newest first. */
    val items: List<AttentionItem>,
    /** The item the row speaks for: the most urgent, ties to the newest. */
    val lead: AttentionItem,
    /** Distinct sessions in the group, so the row can say which terminals are involved. */
    val sessionKeys: List<String>,
    val scope: AttentionScope,
)

/**
 * Urgency for picking a lead: blocked (permission, question, idle) beats broken,
 * then something to do, a nudge, finished work and a note. Lower is more urgent.
 */
private val KIND_RANK = mapOf(
    "permission" to 0,
    "question" to 1,
    "idle" to 2,
    "error" to 3,
    "action" to 4,
    "info" to 5,
    "completed" to 6,
    "message" to 7,
)

/** A kind this build doesn't know ranks after every known one. */
private fun rank(item: AttentionItem) = KIND_RANK[item.kind] ?: KIND_RANK.size

private fun moreUrgent(a: AttentionItem, b: AttentionItem): Boolean =
    if (rank(a) != rank(b)) rank(a) < rank(b) else a.seq > b.seq

/**
 * One group per workspace, else per session, else per item, so a workspace
 * that asks three times reads as one thing wanting the user. Keeps the
 * newest-first order between groups and within them.
 */
fun groupAttentionItems(items: List<AttentionItem>): List<AttentionGroup> {
    val groups = LinkedHashMap<String, AttentionGroup>()
    for (item in items) {
        val scope = when {
            item.workspaceId != null -> AttentionScope(workspaceId = item.workspaceId)
            item.sessionKey != null -> AttentionScope(sessionKey = item.sessionKey)
            else -> AttentionScope()
        }
        val key = when {
            scope.workspaceId != null -> "workspace:${scope.workspaceId}"
            scope.sessionKey != null -> "session:${scope.sessionKey}"
            else -> "item:${item.id}"
        }
        val existing = groups[key]
        groups[key] = if (existing == null) {
            AttentionGroup(key, listOf(item), item, listOfNotNull(item.sessionKey), scope)
        } else {
            existing.copy(
                items = existing.items + item,
                lead = if (moreUrgent(item, existing.lead)) item else existing.lead,
                sessionKeys = if (item.sessionKey == null || item.sessionKey in existing.sessionKeys) {
                    existing.sessionKeys
                } else {
                    existing.sessionKeys + item.sessionKey
                },
            )
        }
    }
    return groups.values.toList()
}

/** One block of the list: a category's groups, or every group when [category] is null. */
data class AttentionSection(val category: String?, val groups: List<AttentionGroup>)

private val RISK_RANK = mapOf("high" to 0, "medium" to 1, "low" to 2)

/** High-risk PRs first. The sort is stable, so each rank stays newest first. */
private fun byRisk(groups: List<AttentionGroup>) = groups.sortedBy { RISK_RANK[it.lead.risk] ?: RISK_RANK.size }

/** A group's category is its lead's; one this build doesn't know counts as general. */
private fun categoryOf(group: AttentionGroup) = group.lead.category.takeIf { it in ATTENTION_CATEGORIES } ?: "general"

/**
 * Lays the groups out. By category, sections come in [ATTENTION_CATEGORIES]
 * order, empty ones left out, and review is ordered by risk. Otherwise one
 * section keeps the groups newest first.
 */
fun arrangeAttention(groups: List<AttentionGroup>, groupByCategory: Boolean = true): List<AttentionSection> {
    if (!groupByCategory) return if (groups.isEmpty()) emptyList() else listOf(AttentionSection(null, groups))
    return ATTENTION_CATEGORIES.map { category ->
        val inCategory = groups.filter { categoryOf(it) == category }
        AttentionSection(category, if (category == "review") byRisk(inCategory) else inCategory)
    }.filter { it.groups.isNotEmpty() }
}

/**
 * Names the terminals a group's items came from, such as `Claude, Shell`.
 * The web reads tab titles from its own storage, which this app doesn't have,
 * so a session is named by its kind.
 */
fun sessionSummary(sessionKeys: List<String>): String? {
    val names = sessionKeys.mapNotNull { key ->
        when {
            key.startsWith(PtyIds.AGENT_PREFIX) -> "Claude"
            key.startsWith(PtyIds.TERMINAL_SURFACE + "/") -> "Terminal"
            key.startsWith("ws:") -> "Shell"
            else -> null
        }
    }.distinct()
    return names.takeIf { it.isNotEmpty() }?.joinToString(", ")
}

/** What a row says the lead is waiting on. */
fun kindHint(item: AttentionItem): String = when {
    item.isClaudePermission -> "Permission prompt"
    item.kind == "question" -> "Question"
    item.headsDownQuestionId != null -> if (item.kind == "permission") "Heads-down approval" else "Heads-down question"
    else -> when (item.kind) {
        "permission" -> "Needs permission to continue"
        "idle" -> "Waiting for your input"
        "error" -> "Hit an error"
        "completed" -> "Finished and ready for you"
        "info" -> "Wants your attention"
        "action" -> "Something for you to do"
        "message" -> "A note for you to read"
        else -> item.kind.replaceFirstChar { it.uppercase() }
    }
}

/** Where tapping an item leads in this app. Null means it opens in the sheet. */
sealed interface AttentionDestination {
    /** The Workspaces tab, on the workspace, with [terminal] on top when set. */
    data class Workspace(val workspaceId: String, val name: String, val terminal: String?) : AttentionDestination

    /** The Terminal tab, on that session. */
    data class Terminal(val sessionKey: String) : AttentionDestination

    data class ChatThread(val sessionId: String) : AttentionDestination
}

/**
 * Where [item] leads, or null when it is answered in the sheet or points
 * somewhere only the web opens (a PR, an issue, a task, heads-down, an artifact).
 */
fun attentionDestination(item: AttentionItem): AttentionDestination? {
    if (item.hasAnswerDialog) return null
    // A hook's item is titled with its workspace's name; anything else's title says what happened.
    val name = if (item.source == "claude-hook") item.title else "Workspace"
    return when (val target = item.target) {
        is AttentionNavTarget.Workspace -> AttentionDestination.Workspace(target.workspaceId, name, terminal = null)
        is AttentionNavTarget.WorkspaceAgent ->
            AttentionDestination.Workspace(target.workspaceId, name, terminal = PtyIds.agent(target.workspaceId))
        is AttentionNavTarget.Terminal -> terminalDestination(target, name)
        is AttentionNavTarget.Chat -> target.sessionId?.let(AttentionDestination::ChatThread)
        is AttentionNavTarget.Other, null -> null
    }
}

/** A workspace's session opens over its workspace; any other opens on the Terminal tab. */
private fun terminalDestination(target: AttentionNavTarget.Terminal, name: String): AttentionDestination? {
    val key = target.sessionKey
    val workspaceId = when {
        key.startsWith(PtyIds.AGENT_PREFIX) -> key.removePrefix(PtyIds.AGENT_PREFIX).ifEmpty { null }
        key.startsWith("ws:") -> key.removePrefix("ws:").substringBefore('/').ifEmpty { null }
        else -> null
    }
    return when {
        workspaceId != null -> AttentionDestination.Workspace(workspaceId, name, terminal = key)
        key.startsWith(PtyIds.TERMINAL_SURFACE + "/") -> AttentionDestination.Terminal(key)
        else -> null
    }
}

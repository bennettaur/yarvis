package dev.yarvis.android.ui.chat

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/** What the waiting line under a running turn says. [seconds] counts from the tool call when one runs. */
fun waitingLabel(runningTool: String?, hasText: Boolean, seconds: Long): String = when {
    runningTool != null -> "Running $runningTool… ${seconds}s"
    hasText -> "Writing… ${seconds}s"
    else -> "Thinking… ${seconds}s"
}

/**
 * True when the list's last item ends within [slack] pixels of the viewport's
 * end, or there's nothing to scroll. A long last item whose top is all that shows is not near.
 */
fun isNearBottom(itemCount: Int, lastVisibleIndex: Int, lastItemEnd: Int, viewportEnd: Int, slack: Int): Boolean =
    itemCount == 0 || (lastVisibleIndex >= itemCount - 1 && lastItemEnd - viewportEnd <= slack)

private val dateFormat = DateTimeFormatter.ofPattern("d MMM")

/** A chat's last activity as the list shows it: "just now", "5 min ago", "3 h ago", "yesterday", then a date. */
fun relativeTime(iso: String, now: Instant, zone: ZoneId = ZoneId.systemDefault()): String {
    val then = try {
        Instant.parse(iso)
    } catch (_: DateTimeParseException) {
        return iso.take(16).replace('T', ' ')
    }
    val ago = Duration.between(then, now)
    return when {
        ago.toMinutes() < 1 -> "just now"
        ago.toMinutes() < 60 -> "${ago.toMinutes()} min ago"
        ago.toHours() < 24 -> "${ago.toHours()} h ago"
        ago.toDays() < 2 -> "yesterday"
        ago.toDays() < 7 -> "${ago.toDays()} days ago"
        else -> dateFormat.format(then.atZone(zone))
    }
}

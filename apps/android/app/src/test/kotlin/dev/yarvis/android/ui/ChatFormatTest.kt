package dev.yarvis.android.ui

import dev.yarvis.android.ui.chat.isNearBottom
import dev.yarvis.android.ui.chat.relativeTime
import dev.yarvis.android.ui.chat.waitingLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class ChatFormatTest {
    @Test
    fun `the waiting line says what the turn is doing`() {
        assertEquals("Thinking… 12s", waitingLabel(runningTool = null, hasText = false, seconds = 12))
        assertEquals("Writing… 12s", waitingLabel(runningTool = null, hasText = true, seconds = 12))
        assertEquals("Running recall… 4s", waitingLabel(runningTool = "recall", hasText = true, seconds = 4))
    }

    @Test
    fun `only a list already at the bottom follows new content`() {
        assertTrue(isNearBottom(itemCount = 0, lastVisibleIndex = -1, lastItemEnd = 0, viewportEnd = 800, slack = 48))
        assertTrue(isNearBottom(itemCount = 5, lastVisibleIndex = 4, lastItemEnd = 820, viewportEnd = 800, slack = 48))
        // Scrolled back up a few messages.
        assertFalse(isNearBottom(itemCount = 5, lastVisibleIndex = 2, lastItemEnd = 790, viewportEnd = 800, slack = 48))
        // The last reply is long and only its top shows.
        assertFalse(isNearBottom(itemCount = 5, lastVisibleIndex = 4, lastItemEnd = 3000, viewportEnd = 800, slack = 48))
    }

    @Test
    fun `chat times read relative to now`() {
        val now = Instant.parse("2026-11-27T12:00:00Z")
        assertEquals("just now", relativeTime("2026-11-27T11:59:40Z", now))
        assertEquals("5 min ago", relativeTime("2026-11-27T11:55:00Z", now))
        assertEquals("3 h ago", relativeTime("2026-11-27T09:00:00Z", now))
        assertEquals("yesterday", relativeTime("2026-11-26T08:00:00Z", now))
        assertEquals("4 days ago", relativeTime("2026-11-23T12:00:00Z", now))
        assertEquals("2 Nov", relativeTime("2026-11-02T12:00:00Z", now, ZoneOffset.UTC))
        assertEquals("not a time", relativeTime("not a time", now))
    }
}

package dev.yarvis.android.ui.attention

import dev.yarvis.android.api.AttentionItem
import dev.yarvis.android.api.AttentionNavTarget
import dev.yarvis.android.api.YarvisJson
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AttentionGroupsTest {
    private fun item(
        id: String,
        seq: Long,
        kind: String = "info",
        workspaceId: String? = null,
        sessionKey: String? = null,
        category: String = "general",
        risk: String? = null,
        source: String = "claude-hook",
        navTarget: JsonElement? = null,
    ) = AttentionItem(
        id = id,
        seq = seq,
        source = source,
        sessionKey = sessionKey,
        workspaceId = workspaceId,
        kind = kind,
        category = category,
        title = "Item $id",
        status = "pending",
        navTarget = navTarget,
        risk = risk,
        createdAt = "2026-11-27T10:00:00Z",
        updatedAt = "2026-11-27T10:00:00Z",
    )

    private fun target(type: String, vararg fields: Pair<String, String>) = buildJsonObject {
        put("type", type)
        for ((name, value) in fields) put(name, value)
    }

    @Test
    fun `items group by workspace, else session, else on their own, newest first`() {
        val groups = groupAttentionItems(
            listOf(
                item("a", 6, workspaceId = "w1", sessionKey = "ws-claude:w1"),
                item("b", 5, sessionKey = "tab:terminal/t1/p1"),
                item("c", 4, workspaceId = "w1", sessionKey = "ws:w1/t1/p1"),
                item("d", 3),
                item("e", 2, sessionKey = "tab:terminal/t1/p1"),
                item("f", 1),
            ),
        )

        assertEquals(listOf("workspace:w1", "session:tab:terminal/t1/p1", "item:d", "item:f"), groups.map { it.key })
        assertEquals(listOf("a", "c"), groups[0].items.map { it.id })
        assertEquals(listOf("ws-claude:w1", "ws:w1/t1/p1"), groups[0].sessionKeys)
        assertEquals(AttentionScope(workspaceId = "w1"), groups[0].scope)
        assertEquals(AttentionScope(sessionKey = "tab:terminal/t1/p1"), groups[1].scope)
        assertEquals(AttentionScope(), groups[2].scope)
    }

    @Test
    fun `a permission among idles leads its group`() {
        val group = groupAttentionItems(
            listOf(
                item("idle-new", 3, kind = "idle", workspaceId = "w1"),
                item("perm", 2, kind = "permission", workspaceId = "w1"),
                item("idle-old", 1, kind = "idle", workspaceId = "w1"),
            ),
        ).single()

        assertEquals("perm", group.lead.id)
        assertEquals(3, group.items.size)
    }

    @Test
    fun `ties on kind go to the newest, and an unknown kind ranks last`() {
        val tie = groupAttentionItems(listOf(item("old", 1, kind = "idle", workspaceId = "w1"), item("new", 2, kind = "idle", workspaceId = "w1"))).single()
        assertEquals("new", tie.lead.id)

        val unknown = groupAttentionItems(listOf(item("x", 2, kind = "shiny", workspaceId = "w1"), item("m", 1, kind = "message", workspaceId = "w1"))).single()
        assertEquals("m", unknown.lead.id)
    }

    @Test
    fun `sections follow the category order, leave out empty ones, and sort review by risk`() {
        val groups = groupAttentionItems(
            listOf(
                item("g", 7),
                item("low", 6, category = "review", risk = "low"),
                item("none", 5, category = "review"),
                item("high", 4, category = "review", risk = "high"),
                item("b", 3, category = "build"),
                item("med", 2, category = "review", risk = "medium"),
                item("odd", 1, category = "something-new"),
            ),
        )

        val sections = arrangeAttention(groups)

        assertEquals(listOf("review", "build", "general"), sections.map { it.category })
        assertEquals(listOf("high", "med", "low", "none"), sections[0].groups.map { it.lead.id })
        assertEquals(listOf("g", "odd"), sections[2].groups.map { it.lead.id })
    }

    @Test
    fun `ungrouped keeps one newest-first section, and nothing gives no sections`() {
        val groups = groupAttentionItems(listOf(item("a", 2, category = "build"), item("b", 1, category = "review", risk = "high")))

        assertEquals(listOf(AttentionSection(null, groups)), arrangeAttention(groups, groupByCategory = false))
        assertTrue(arrangeAttention(emptyList()).isEmpty())
        assertTrue(arrangeAttention(emptyList(), groupByCategory = false).isEmpty())
    }

    @Test
    fun `the session summary names each kind of terminal once`() {
        assertEquals("Claude, Shell", sessionSummary(listOf("ws-claude:w1", "ws:w1/t1/p1", "ws:w1/t2/p1")))
        assertEquals("Terminal", sessionSummary(listOf("tab:terminal/t1/p1")))
        assertNull(sessionSummary(listOf("heads-down:q1")))
    }

    @Test
    fun `nav targets decode leniently`() {
        assertEquals(AttentionNavTarget.WorkspaceAgent("w1"), AttentionNavTarget.from(target("workspace-claude", "workspaceId" to "w1")))
        assertEquals(AttentionNavTarget.Terminal("ws:w1/t/p", "w1"), AttentionNavTarget.from(target("terminal", "sessionKey" to "ws:w1/t/p", "workspaceId" to "w1")))
        assertEquals(AttentionNavTarget.Chat(null), AttentionNavTarget.from(target("chat")))
        assertEquals(AttentionNavTarget.Other("pr"), AttentionNavTarget.from(target("pr", "owner" to "acme")))
        assertEquals(AttentionNavTarget.Other("workspace"), AttentionNavTarget.from(target("workspace")))
        assertNull(AttentionNavTarget.from(null))
        assertNull(AttentionNavTarget.from(JsonPrimitive("workspace")))
    }

    @Test
    fun `an item decodes with or without the new fields`() {
        val bare = YarvisJson.decodeFromString(
            AttentionItem.serializer(),
            """{"id":"a","seq":1,"source":"system","kind":"info","title":"t","status":"pending","createdAt":"","updatedAt":""}""",
        )
        assertEquals("general", bare.category)
        assertNull(bare.target)

        val full = YarvisJson.decodeFromString(
            AttentionItem.serializer(),
            """{"id":"a","seq":1,"source":"system","kind":"info","category":"review","risk":"high","title":"t","status":"pending",
               "navTarget":{"type":"review-workspace","workspaceId":"w","prId":"p"},"createdAt":"","updatedAt":""}""",
        )
        assertEquals("review", full.category)
        assertEquals("high", full.risk)
        assertEquals(AttentionNavTarget.Other("review-workspace"), full.target)
    }

    @Test
    fun `answer dialogs are questions, heads-down items and hook permissions with a session`() {
        assertTrue(item("q", 1, kind = "question").hasAnswerDialog)
        assertTrue(item("h", 1, kind = "info", source = "system", sessionKey = "heads-down:q1").hasAnswerDialog)
        assertTrue(item("p", 1, kind = "permission", sessionKey = "ws-claude:w1").hasAnswerDialog)
        assertFalse(item("p", 1, kind = "permission").hasAnswerDialog)
        assertFalse(item("p", 1, kind = "permission", source = "system", sessionKey = "ws-claude:w1").hasAnswerDialog)
        assertFalse(item("i", 1, kind = "idle", sessionKey = "ws-claude:w1").hasAnswerDialog)
    }

    @Test
    fun `a finished or waiting agent opens its workspace with the agent on top`() {
        val idle = item("i", 1, kind = "idle", workspaceId = "w1", sessionKey = "ws-claude:w1", navTarget = target("workspace-claude", "workspaceId" to "w1"))

        assertEquals(AttentionDestination.Workspace("w1", "Item i", terminal = "ws-claude:w1"), attentionDestination(idle))
        assertEquals(
            AttentionDestination.Workspace("w1", "Item i", terminal = "ws-claude:w1"),
            attentionDestination(idle.copy(kind = "completed")),
        )
    }

    @Test
    fun `each nav target maps to where the app opens it`() {
        fun dest(vararg fields: Pair<String, String>, type: String, source: String = "claude-hook") =
            attentionDestination(item("x", 1, kind = "completed", source = source, navTarget = target(type, *fields)))

        assertEquals(AttentionDestination.Workspace("w1", "Workspace", terminal = null), dest("workspaceId" to "w1", type = "workspace", source = "system"))
        assertEquals(AttentionDestination.Workspace("w1", "Item x", terminal = "ws:w1/t1/p1"), dest("sessionKey" to "ws:w1/t1/p1", "workspaceId" to "w1", type = "terminal"))
        assertEquals(AttentionDestination.Workspace("w2", "Item x", terminal = "ws-claude:w2"), dest("sessionKey" to "ws-claude:w2", type = "terminal"))
        assertEquals(AttentionDestination.Terminal("tab:terminal/t1/p1"), dest("sessionKey" to "tab:terminal/t1/p1", type = "terminal"))
        assertNull(dest("sessionKey" to "review-claude:r1", type = "terminal"))
        assertEquals(AttentionDestination.ChatThread("c1"), dest("sessionId" to "c1", type = "chat"))
        assertNull(dest(type = "chat"))
        for (other in listOf("pr", "azure-pr", "issue", "task", "heads-down", "artifact", "review-workspace")) {
            assertNull(other, dest(type = other))
        }
        assertNull(attentionDestination(item("none", 1)))
    }

    @Test
    fun `an item with an answer dialog opens in the sheet whatever its target`() {
        val permission = item("p", 1, kind = "permission", workspaceId = "w1", sessionKey = "ws-claude:w1", navTarget = target("workspace-claude", "workspaceId" to "w1"))

        assertNull(attentionDestination(permission))
    }
}

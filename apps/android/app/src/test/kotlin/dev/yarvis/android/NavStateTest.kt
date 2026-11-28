package dev.yarvis.android

import dev.yarvis.android.ui.attention.AttentionDestination
import org.junit.Assert.assertEquals
import org.junit.Test

class NavStateTest {
    @Test
    fun `a workspace's agent opens over the workspace, over the list`() {
        val nav = NavState().open(AttentionDestination.Workspace("w1", "api", terminal = "ws-claude:w1"))

        assertEquals(Tab.Workspaces, nav.tab)
        assertEquals(
            listOf(Route.WorkspaceList, Route.Workspace("w1", "api"), Route.Terminal("ws-claude:w1", "api · Claude", cwd = null)),
            nav.stack,
        )
        assertEquals(listOf(Route.WorkspaceList, Route.Workspace("w1", "api")), nav.pop().stack)
    }

    @Test
    fun `a workspace shell and a bare workspace build their stacks`() {
        val shell = NavState().open(AttentionDestination.Workspace("w1", "api", terminal = "ws:w1/t1/p1"))
        assertEquals(Route.Terminal("ws:w1/t1/p1", "api · shell", cwd = null), shell.top)

        val bare = NavState().open(AttentionDestination.Workspace("w1", "api", terminal = null))
        assertEquals(listOf(Route.WorkspaceList, Route.Workspace("w1", "api")), bare.stack)
    }

    @Test
    fun `a Terminal-tab session and a chat open on their own tabs`() {
        val terminal = NavState().open(AttentionDestination.Terminal("tab:terminal/t1/p1"))
        assertEquals(Tab.Terminal, terminal.tab)
        assertEquals(listOf(Route.TerminalSessions, Route.Terminal("tab:terminal/t1/p1", "Terminal", cwd = null)), terminal.stack)

        val chat = NavState().open(AttentionDestination.ChatThread("c1"))
        assertEquals(Tab.Chat, chat.tab)
        assertEquals(listOf(Route.ChatList, Route.ChatThread("c1")), chat.stack)
    }

    @Test
    fun `opening leaves the other tabs' stacks alone`() {
        val start = NavState().select(Tab.Chat).push(Route.ChatThread("c9"))

        val nav = start.open(AttentionDestination.Workspace("w1", "api", terminal = null))

        assertEquals(listOf(Route.ChatList, Route.ChatThread("c9")), nav.stacks[Tab.Chat])
        assertEquals(listOf(Route.Attention), nav.stacks[Tab.Attention])
    }
}

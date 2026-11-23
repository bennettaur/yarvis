package dev.yarvis.android.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUrlTest {
    @Test
    fun `a bare tailnet name gets https`() {
        assertEquals("https://yarvis.tail1234.ts.net/", ServerUrl.parse(" yarvis.tail1234.ts.net/ ").getOrThrow().toString())
    }

    @Test
    fun `a path and query are dropped so routes resolve from the origin`() {
        assertEquals("https://host.ts.net:8443/", ServerUrl.parse("https://host.ts.net:8443/chat?x=1").getOrThrow().toString())
    }

    @Test
    fun `plain http is refused`() {
        assertTrue(ServerUrl.parse("http://host.ts.net").isFailure)
    }

    @Test
    fun `empty and malformed input are refused`() {
        assertTrue(ServerUrl.parse("  ").isFailure)
        assertTrue(ServerUrl.parse("https://exa mple.ts.net").isFailure)
    }
}

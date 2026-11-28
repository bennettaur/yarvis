package dev.yarvis.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.CreationExtras
import kotlin.reflect.KClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class RouteStoresTest {
    private class Probe : ViewModel() {
        var cleared = false

        override fun onCleared() {
            cleared = true
        }
    }

    private val factory = object : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: KClass<T>, extras: CreationExtras): T = Probe() as T
    }

    private fun RouteStores.probe(key: String): Probe = ViewModelProvider.create(owner(key), factory)[Probe::class]

    @Test
    fun `a screen gets the same view models until it leaves its stack`() {
        val stores = RouteStores()
        val first = stores.probe("a")

        assertSame(first, stores.probe("a"))
        stores.retain(setOf("a", "b"))
        assertSame(first, stores.probe("a"))
        assertFalse(first.cleared)
    }

    @Test
    fun `retain clears the screens that left`() {
        val stores = RouteStores()
        val kept = stores.probe("list")
        val popped = stores.probe("terminal")

        stores.retain(setOf("list"))

        assertTrue(popped.cleared)
        assertFalse(kept.cleared)
        assertEquals(setOf("list"), stores.keys)
        // Coming back to the same key makes a fresh view model.
        assertFalse(stores.probe("terminal").cleared)
    }

    @Test
    fun `sign-out clears every screen`() {
        val stores = RouteStores()
        val a = stores.probe("a")
        val b = stores.probe("b")

        stores.clearAll()

        assertTrue(a.cleared && b.cleared)
        assertTrue(stores.keys.isEmpty())
    }
}

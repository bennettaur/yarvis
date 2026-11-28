package dev.yarvis.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner

/**
 * One [ViewModelStore] per screen on the navigation stacks. A screen's view
 * models are cleared when it leaves its stack, so a closed terminal drops its
 * socket rather than holding it until the activity finishes.
 */
class RouteStores {
    private val stores = LinkedHashMap<String, ViewModelStore>()

    /** The store for the screen [key] names, made on first use. */
    fun owner(key: String): ViewModelStoreOwner {
        val store = stores.getOrPut(key) { ViewModelStore() }
        return object : ViewModelStoreOwner {
            override val viewModelStore = store
        }
    }

    /** Clears the stores of every screen not in [live]. */
    fun retain(live: Set<String>) {
        val gone = stores.keys - live
        for (key in gone) stores.remove(key)?.clear()
    }

    fun clearAll() = retain(emptySet())

    val keys: Set<String> get() = stores.keys.toSet()
}

/** Holds [RouteStores] at the activity's scope, so the stores outlive a rotation. */
class RouteStoresViewModel : ViewModel() {
    val stores = RouteStores()

    override fun onCleared() = stores.clearAll()
}

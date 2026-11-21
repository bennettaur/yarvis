package dev.yarvis.android.data

/** The provider and model the last chat used, so the next one starts there. */
interface ChatModelPrefs {
    suspend fun load(): Pair<String, String>?
    suspend fun save(provider: String, model: String)
}

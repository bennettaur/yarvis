package dev.yarvis.android.data

data class ChatModelChoice(val provider: String, val model: String)

/** The provider and model the last chat used, so the next one starts there. */
interface ChatModelPrefs {
    suspend fun load(): ChatModelChoice?
    suspend fun save(provider: String, model: String)
}

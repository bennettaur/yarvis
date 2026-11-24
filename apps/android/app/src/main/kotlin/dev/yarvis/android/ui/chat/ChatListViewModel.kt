package dev.yarvis.android.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.yarvis.android.api.ChatApi
import dev.yarvis.android.api.ChatSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ChatListState(
    val sessions: List<ChatSession> = emptyList(),
    val loading: Boolean = true,
    val error: String? = null,
)

class ChatListViewModel(private val api: ChatApi) : ViewModel() {
    private val _state = MutableStateFlow(ChatListState())
    val state: StateFlow<ChatListState> = _state.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        _state.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                val sessions = api.sessions()
                _state.update { it.copy(sessions = sessions, loading = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = "Couldn't load chats: ${e.message}") }
            }
        }
    }
}

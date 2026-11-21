package dev.yarvis.android.data

import dev.yarvis.android.api.CodePrompt
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Asks for an authenticator code when the server wants a recent one. The UI
 * shows a dialog while [asking] is true and answers with [submit] or [cancel].
 * Requests wait their turn, so two answers in flight share one dialog at a time.
 */
class CodePromptState : CodePrompt {
    private val mutex = Mutex()
    private var pending: CompletableDeferred<String?>? = null
    private val _asking = MutableStateFlow(false)
    val asking: StateFlow<Boolean> = _asking.asStateFlow()

    override suspend fun requestCode(): String? = mutex.withLock {
        val answer = CompletableDeferred<String?>()
        pending = answer
        _asking.value = true
        try {
            answer.await()
        } finally {
            pending = null
            _asking.value = false
        }
    }

    fun submit(code: String) {
        pending?.complete(code.trim())
    }

    fun cancel() {
        pending?.complete(null)
    }
}
